import sdk from 'matrix-js-sdk';
import { adminClient } from '../utils/supabase.js';
import { logger } from '../utils/logger.js';
import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
import { redisClient } from './redisService.js';

// Add the old function signature that uses the new implementation
export async function initializeMatrixClient(accessToken, userId) {
  try {
    if (!accessToken) {
      throw new Error('Access token is required');
    }

    // If userId not provided, try to get it from whoami
    if (!userId) {
      const tempClient = sdk.createClient({
        baseUrl: process.env.MATRIX_HOMESERVER_URL,
        accessToken,
        useAuthorizationHeader: true
      });
      const whoami = await tempClient.whoami();
      userId = whoami.user_id;
    }

    // Use the new service to initialize the client
    const client = await matrixService.getClient(userId);
    if (!client) {
      throw new Error('Failed to initialize Matrix client');
    }

    return client;
  } catch (error) {
    logger.error('[Matrix] Initialization failed:', error);
    throw error;
  }
}

class MatrixService {
  constructor() {
    this.clients = new Map();
    this.initPromises = new Map();
    this.healthChecks = new Map();
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 2000;
    this.rateLimiters = new Map();
    this.SYNC_TIMEOUT = 30000; // 30 seconds max for sync
    this.RATE_LIMIT_CLEANUP_INTERVAL = setInterval(() => this._cleanupRateLimiters(), 300000); // 5 minutes
  }

  async _cleanupRateLimiters() {
    const now = Date.now();
    for (const [userId, limiter] of this.rateLimiters.entries()) {
      if (now - limiter.lastRequest > 300000) { // 5 minutes
        if (limiter.resetTimeout) {
          clearTimeout(limiter.resetTimeout);
        }
        this.rateLimiters.delete(userId);
      }
    }
  }

  async _getRateLimiter(userId) {
    if (!this.rateLimiters.has(userId)) {
      this.rateLimiters.set(userId, {
        lastRequest: Date.now(),
        requestCount: 0,
        resetTimeout: null
      });
    }
    return this.rateLimiters.get(userId);
  }

  async _checkRateLimit(userId) {
    const limiter = await this._getRateLimiter(userId);
    const now = Date.now();
    
    // Reset counter if more than 60 seconds have passed
    if (now - limiter.lastRequest > 60000) {
      limiter.requestCount = 0;
    }

    // Allow 30 requests per minute
    if (limiter.requestCount >= 30) {
      throw new Error('Rate limit exceeded');
    }

    limiter.requestCount++;
    limiter.lastRequest = now;

    // Clear existing timeout
    if (limiter.resetTimeout) {
      clearTimeout(limiter.resetTimeout);
    }

    // Set new timeout
    limiter.resetTimeout = setTimeout(() => {
      limiter.requestCount = 0;
      limiter.resetTimeout = null;
    }, 60000);

    return true;
  }

  async getClient(userId) {
    try {
      // Check rate limit first
      await this._checkRateLimit(userId);

      // Return existing initialized client
      const existingClient = this.clients.get(userId);
      if (existingClient?.clientRunning) {
        return existingClient;
      }

      // Check if initialization is in progress
      const initPromise = this.initPromises.get(userId);
      if (initPromise) {
        return initPromise;
      }

      // Start new initialization
      const promise = this._initializeClient(userId);
      this.initPromises.set(userId, promise);

      try {
        const client = await promise;
        return client;
      } finally {
        this.initPromises.delete(userId);
      }
    } catch (error) {
      logger.error('[Matrix] Client initialization error:', {
        userId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async _initializeClient(userId) {
    try {
      // Get Matrix credentials from database
      const { data: account, error } = await adminClient
        .from('accounts')
        .select('credentials, bridge_room_id')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (error || !account?.credentials) {
        logger.error('[Matrix] Failed to get account:', { error, userId });
        return null;
      }

      const { homeserver, accessToken, userId: matrixUserId } = account.credentials;

      // Validate required credentials
      if (!homeserver || !accessToken || !matrixUserId) {
        logger.error('[Matrix] Invalid credentials:', {
          hasHomeserver: !!homeserver,
          hasAccessToken: !!accessToken,
          hasUserId: !!matrixUserId,
          userId
        });
        return null;
      }

      // Create client with retry logic
      const client = await this._createClientWithRetry({
        baseUrl: homeserver,
        accessToken,
        userId: matrixUserId,
        timeoutMs: BRIDGE_TIMEOUTS.REQUEST,
        useAuthorizationHeader: true
      });

      if (!client) {
        throw new Error('Failed to create Matrix client');
      }

      // Store bridge room ID if available
      if (account.bridge_room_id) {
        client.bridgeRoomId = account.bridge_room_id;
      }

      // Start client and wait for sync
      await this._startClientWithRetry(client);

      // Store initialized client
      this.clients.set(userId, client);
      client.clientRunning = true;
      
      // Start health checks
      this._startHealthCheck(userId, client);

      return client;

    } catch (error) {
      logger.error('[Matrix] Client initialization failed:', {
        userId,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  async _createClientWithRetry(config, retryCount = 0) {
    try {
      const client = sdk.createClient(config);
      return client;
    } catch (error) {
      if (retryCount < this.MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, retryCount)));
        return this._createClientWithRetry(config, retryCount + 1);
      }
      throw error;
    }
  }

  async _startClientWithRetry(client, retryCount = 0) {
    try {
      await client.startClient({ initialSyncLimit: 10 });
      await this._waitForSync(client);
      return true;
    } catch (error) {
      if (retryCount < this.MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, retryCount)));
        return this._startClientWithRetry(client, retryCount + 1);
      }
      throw error;
    }
  }

  async _waitForSync(client) {
    return new Promise((resolve, reject) => {
      let syncTimeout;
      let checkInterval;

      const cleanup = () => {
        if (syncTimeout) clearTimeout(syncTimeout);
        if (checkInterval) clearInterval(checkInterval);
        client.removeAllListeners('sync');
      };

      syncTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('Initial sync timeout'));
      }, this.SYNC_TIMEOUT);

      checkInterval = setInterval(() => {
        if (client.isInitialSyncComplete()) {
          cleanup();
          resolve();
        }
      }, 1000);

      client.once('sync', (state) => {
        if (state === 'PREPARED') {
          cleanup();
          resolve();
        } else if (state === 'ERROR') {
          cleanup();
          reject(new Error('Sync failed'));
        }
      });
    });
  }

  _startHealthCheck(userId, client) {
    if (this.healthChecks.has(userId)) {
      clearInterval(this.healthChecks.get(userId));
    }

    const interval = setInterval(async () => {
      try {
        const isHealthy = await this._checkClientHealth(client);
        if (!isHealthy) {
          logger.warn('[Matrix] Unhealthy client detected:', userId);
          await this._handleUnhealthyClient(userId, client);
        }
      } catch (error) {
        logger.error('[Matrix] Health check failed:', error);
      }
    }, BRIDGE_CONFIGS.HEALTH_CHECK_INTERVAL);

    this.healthChecks.set(userId, interval);
  }

  async _checkClientHealth(client) {
    try {
      const syncState = client.getSyncState();
      if (syncState === null || syncState === 'ERROR') {
        return false;
      }

      await client.whoami();
      return true;
    } catch (error) {
      return false;
    }
  }

  async _handleUnhealthyClient(userId, client) {
    try {
      // Clear existing health check
      if (this.healthChecks.has(userId)) {
        clearInterval(this.healthChecks.get(userId));
        this.healthChecks.delete(userId);
      }

      // Stop and cleanup client
      await client.stopClient();
      this.clients.delete(userId);

      // Clear rate limiter
      const limiter = this.rateLimiters.get(userId);
      if (limiter?.resetTimeout) {
        clearTimeout(limiter.resetTimeout);
      }
      this.rateLimiters.delete(userId);

      // Try to reinitialize
      await this.getClient(userId);
    } catch (error) {
      logger.error('[Matrix] Recovery failed:', error);
    }
  }

  async cleanup(userId) {
    try {
      const client = this.clients.get(userId);
      if (client) {
        await client.stopClient();
        this.clients.delete(userId);
      }

      if (this.healthChecks.has(userId)) {
        clearInterval(this.healthChecks.get(userId));
        this.healthChecks.delete(userId);
      }
    } catch (error) {
      logger.error('[Matrix] Cleanup failed:', error);
    }
  }

  async getMatrixMessages(userId, roomId, limit = 50, from = null) {
    try {
      const client = await this.getClient(userId);
      if (!client) {
        throw new Error('Matrix client not initialized');
      }

      const room = client.getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }

      const timeline = await client.createMessagesRequest(roomId, from, limit, 'b');
      if (!timeline?.chunk) {
        return [];
      }

      return timeline.chunk.map(event => ({
        event_id: event.event_id,
        sender: event.sender,
        content: event.content,
        type: event.type,
        timestamp: event.origin_server_ts,
        room_id: roomId
      }));
    } catch (error) {
      logger.error('[Matrix] Failed to get messages:', error);
      throw error;
    }
  }

  destroy() {
    // Clear rate limiter cleanup interval
    if (this.RATE_LIMIT_CLEANUP_INTERVAL) {
      clearInterval(this.RATE_LIMIT_CLEANUP_INTERVAL);
    }

    // Clear all rate limiter timeouts
    for (const limiter of this.rateLimiters.values()) {
      if (limiter.resetTimeout) {
        clearTimeout(limiter.resetTimeout);
      }
    }
    this.rateLimiters.clear();

    // Clear all health checks
    for (const interval of this.healthChecks.values()) {
      clearInterval(interval);
    }
    this.healthChecks.clear();

    // Stop all clients
    for (const [userId, client] of this.clients.entries()) {
      try {
        client.stopClient();
      } catch (error) {
        logger.error('[Matrix] Error stopping client:', { userId, error });
      }
    }
    this.clients.clear();
  }
}

export const matrixService = new MatrixService();
export default matrixService;