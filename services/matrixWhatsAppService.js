import sdk from 'matrix-js-sdk';
import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
import { supabase, adminClient } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { getIO } from '../utils/socket.js';
import {
  validateMatrixServer,
  validateCredentialsFormat,
  validateBridgeBot,
  validateUserPermissions,
  waitForBridgeBotJoin
} from '../utils/matrixValidation.js';
import { createClient } from 'redis';
import { redisConfig } from '../config/redis.js';
import { tokenService } from '../services/tokenService.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/backoff.js';
import RateLimit from 'async-ratelimiter';
import { promisify } from 'util';
import Redlock from 'redlock';
import { DistributedLock } from '../utils/lockManager.js';
import { redisService } from '../utils/redis.js';

const SYNC_BATCH_SIZE = parseInt(process.env.MATRIX_SYNC_BATCH_SIZE || '50', 10);
const MAX_SYNC_BATCHES = parseInt(process.env.MATRIX_MAX_SYNC_BATCHES || '5', 10);
const MAX_SYNC_RETRIES = parseInt(process.env.MATRIX_SYNC_RETRIES || '3', 10);

const pubClient = createClient(redisConfig);
await pubClient.connect();

const redlock = new Redlock([pubClient], {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 200
});

const ERROR_TYPES = {
  NETWORK: 'NETWORK_ERROR',
  AUTH: 'AUTH_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION_ERROR',
  SYNC: 'SYNC_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
  RECOVERABLE: 'recoverable',
  PERMANENT: 'permanent'
};

const ERROR_BOUNDARIES = {
  CRITICAL: {
    MAX_RETRIES: 2,
    BACKOFF_MS: 5000,
    REQUIRES_ADMIN: true
  },
  RECOVERABLE: {
    MAX_RETRIES: 3,
    BACKOFF_MS: 2000,
    REQUIRES_ADMIN: false
  },
  TRANSIENT: {
    MAX_RETRIES: 5,
    BACKOFF_MS: 1000,
    REQUIRES_ADMIN: false
  }
};

const getErrorType = (error) => {
  if (error.name === 'ConnectionError' || error.code === 'ECONNREFUSED') {
    return ERROR_TYPES.NETWORK;
  }
  if (error.errcode === 'M_UNKNOWN_TOKEN' || error.errcode === 'M_MISSING_TOKEN') {
    return ERROR_TYPES.AUTH;
  }
  if (error.errcode === 'M_LIMIT_EXCEEDED') {
    return ERROR_TYPES.RATE_LIMIT;
  }
  if (error.message.includes('validation')) {
    return ERROR_TYPES.VALIDATION;
  }
  if (error.message.includes('sync')) {
    return ERROR_TYPES.SYNC;
  }
  return ERROR_TYPES.UNKNOWN;
};

const SYNC_STATES = {
  PREPARING: 'preparing',
  FETCHING: 'fetching',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error',
  RETRYING: 'retrying',
  OFFLINE: 'offline',
  RESUMING: 'resuming'
};

const CONNECTION_STATES = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ERROR: 'error',
  CONNECTING: 'connecting'
};

const CONNECTION_HEALTH = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
};

const RATE_LIMITS = {
  SYNC: {
    MAX: 30,  // max requests
    DURATION: 60000,  // per minute
    BACKOFF: 2000  // base backoff in ms
  },
  TOKEN_REFRESH: {
    MAX: 5,
    DURATION: 60000,
    BACKOFF: 5000
  }
};

// Initialize rate limiters with Redis
const syncLimiter = new RateLimit({
  db: pubClient,
  max: RATE_LIMITS.SYNC.MAX,
  duration: RATE_LIMITS.SYNC.DURATION,
  namespace: 'matrix-sync'
});

const tokenLimiter = new RateLimit({
  db: pubClient,
  max: RATE_LIMITS.TOKEN_REFRESH.MAX,
  duration: RATE_LIMITS.TOKEN_REFRESH.DURATION,
  namespace: 'token-refresh'
});

const SYNC_CONFIGS = {
  INITIAL_TIMEOUT: 60000,  // 60 seconds for initial sync
  INCREMENTAL_TIMEOUT: 30000,  // 30 seconds for incremental syncs
  MAX_RETRIES: 5,
  BASE_BACKOFF: 2000,
  MAX_BACKOFF: 32000
};

class MatrixWhatsAppService {
  constructor() {
    this.matrixClients = new Map();
    this.connections = new Map();
    this.syncStates = new Map();
    this.messageHandlers = new Map();
    this.roomToContactMap = new Map();
    this.connectionAttempts = new Map();
    this.MAX_RECONNECT_ATTEMPTS = 3;
    this.RECONNECT_DELAY = 2000;
    this.bridgeRooms = new Map();
    this.connectionStates = new Map();
    this.healthCheckIntervals = new Map();
    this.reconnectAttempts = new Map();
    this.HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
    
    // Enhanced connection pool management
    this.connectionPool = {
      active: new Map(),
      idle: new Map(),
      MAX_ACTIVE: 100,
      MAX_IDLE: 10,
      IDLE_TIMEOUT: 300000, // 5 minutes
      cleanupInterval: 60000 // 1 minute
    };

    // Enhanced error tracking with thresholds
    this.errorTracking = {
      counts: new Map(),
      thresholds: {
      RATE_LIMIT: 5,
      AUTH: 3,
      NETWORK: 10,
      SYNC: 5
      },
      resetInterval: 3600000 // 1 hour
    };
    
    // Initialize rate limiters
    this.syncLimiter = syncLimiter;
    this.tokenLimiter = tokenLimiter;

    // Initialize redlock with error handling
    try {
      if (!pubClient.isReady) {
        logger.warn('[Matrix Service] Redis client not ready, redlock will be initialized later');
        this.redlock = null;
      } else {
        this.redlock = new Redlock([pubClient], {
          driftFactor: 0.01,
          retryCount: 3,
          retryDelay: 200,
          retryJitter: 200
        });
        logger.info('[Matrix Service] Redlock initialized successfully');
      }
    } catch (error) {
      logger.error('[Matrix Service] Failed to initialize redlock:', error);
      this.redlock = null;
    }

    // Start maintenance tasks
    this.startMaintenanceTasks();
    this.lockManager = new DistributedLock(pubClient);
  }

  async startMaintenanceTasks() {
    // Connection pool cleanup
    setInterval(() => this.cleanupConnections(), this.connectionPool.cleanupInterval);
    
    // Error count reset
    setInterval(() => this.resetErrorCounts(), this.errorTracking.resetInterval);
    
    // Health check for active connections
    setInterval(() => this.checkConnectionHealth(), this.HEALTH_CHECK_INTERVAL);
  }

  async cleanupConnections() {
    const now = Date.now();
    
    // Cleanup idle connections
    for (const [userId, conn] of this.connectionPool.idle.entries()) {
      if (now - conn.lastUsed > this.connectionPool.IDLE_TIMEOUT) {
        await this.closeConnection(userId, conn);
        this.connectionPool.idle.delete(userId);
      }
    }

    // Move inactive connections to idle pool
    for (const [userId, conn] of this.connectionPool.active.entries()) {
      if (now - conn.lastUsed > this.connectionPool.IDLE_TIMEOUT / 2) {
        this.connectionPool.active.delete(userId);
        this.connectionPool.idle.set(userId, {
          ...conn,
          lastUsed: now
        });
      }
    }
  }

  async checkConnectionHealth() {
    try {
      // Check active connections
      for (const [userId, conn] of this.connectionPool.active.entries()) {
        try {
          const isHealthy = await this.verifyConnection(userId, conn);
          if (!isHealthy) {
            logger.warn('[Matrix Service] Unhealthy connection detected:', { userId });
            await this.handleUnhealthyConnection(userId, conn);
          }
        } catch (error) {
          logger.error('[Matrix Service] Health check failed for user:', {
            userId,
            error: error.message
          });
        }
      }

      // Check idle connections periodically
      const now = Date.now();
      if (now % (this.HEALTH_CHECK_INTERVAL * 2) === 0) {
        for (const [userId, conn] of this.connectionPool.idle.entries()) {
          try {
            const isHealthy = await this.verifyConnection(userId, conn);
            if (!isHealthy) {
              logger.warn('[Matrix Service] Removing unhealthy idle connection:', { userId });
              await this.closeConnection(userId, conn);
              this.connectionPool.idle.delete(userId);
            }
          } catch (error) {
            logger.error('[Matrix Service] Idle connection health check failed:', {
              userId,
              error: error.message
            });
          }
        }
      }
    } catch (error) {
      logger.error('[Matrix Service] Connection health check error:', error);
    }
  }

  async verifyConnection(userId, conn) {
    try {
      if (!conn?.client?.isRunning()) {
        return false;
      }

      // Verify Matrix client is responsive
      const whoami = await conn.client.whoami();
      if (!whoami || whoami.user_id !== conn.client.getUserId()) {
        return false;
      }

      // Check sync state
      const syncState = this.syncStates.get(userId);
      if (syncState === SYNC_STATES.ERROR || syncState === SYNC_STATES.OFFLINE) {
        return false;
      }

      // Update last activity
      conn.lastUsed = Date.now();
      return true;
    } catch (error) {
      logger.error('[Matrix Service] Connection verification failed:', {
        userId,
        error: error.message
      });
      return false;
    }
  }

  async handleUnhealthyConnection(userId, conn) {
    try {
      // Move to idle pool first
      this.connectionPool.active.delete(userId);
      
      // Attempt reconnection
      const attempts = this.reconnectAttempts.get(userId) || 0;
      if (attempts < this.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts.set(userId, attempts + 1);
        
        // Wait before retry
        await sleep(this.RECONNECT_DELAY * Math.pow(2, attempts));
        
        // Attempt to create new connection
        const newConn = await this.createConnection(userId);
        if (newConn) {
          this.connectionPool.active.set(userId, {
            client: newConn,
            lastUsed: Date.now(),
            status: 'active'
          });
          this.reconnectAttempts.delete(userId);
          logger.info('[Matrix Service] Successfully reconnected:', { userId });
          return;
        }
      }

      // If reconnection fails or max attempts reached, cleanup
      await this.closeConnection(userId, conn);
      this.reconnectAttempts.delete(userId);
      
      // Notify about connection failure
      ioEmitter.emit('matrix:connection:error', {
        userId,
        error: 'Connection health check failed',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[Matrix Service] Error handling unhealthy connection:', {
        userId,
        error: error.message
      });
    }
  }

  async closeConnection(userId, conn) {
    try {
      // Cleanup Matrix client
      if (conn.client) {
        conn.client.removeAllListeners();
        await conn.client.stopClient();
      }

      // Clear associated resources
      this.matrixClients.delete(userId);
      this.connections.delete(userId);
      this.syncStates.delete(userId);
      this.messageHandlers.delete(userId);
      
      logger.info('[Matrix Service] Closed connection for user:', userId);
    } catch (error) {
      logger.error('[Matrix Service] Error closing connection:', {
        userId,
        error: error.message
      });
    }
  }

  async getConnection(userId) {
    return this.lockManager.withLock(`matrix:connection:${userId}`, async () => {
      // Check active connections
      let conn = this.connectionPool.active.get(userId);
      if (conn?.client?.isRunning()) {
        conn.lastUsed = Date.now();
        return conn;
      }

      // Check idle connections
      conn = this.connectionPool.idle.get(userId);
      if (conn?.client?.isRunning()) {
        this.connectionPool.idle.delete(userId);
        conn.lastUsed = Date.now();
        this.connectionPool.active.set(userId, conn);
        return conn;
      }

      // Create new connection if under limits
      if (this.connectionPool.active.size < this.connectionPool.MAX_ACTIVE) {
        const newConn = await this.createConnection(userId);
        this.connectionPool.active.set(userId, {
          client: newConn,
          lastUsed: Date.now(),
          status: 'active'
        });
        return newConn;
      }

      throw new Error('Connection pool exhausted');
    });
  }

  async createConnection(userId) {
    try {
      // Get credentials from token service
      const tokens = await tokenService.getValidToken(userId);
      if (!tokens?.access_token) {
        throw new Error('No valid token available');
      }

      // Initialize Matrix client with enhanced options
      const client = sdk.createClient({
        baseUrl: process.env.MATRIX_HOMESERVER_URL,
        accessToken: tokens.access_token,
        userId,
        timeoutMs: 60000,
        localTimeoutMs: 30000,
        useAuthorizationHeader: true,
        retryIf: async (attempt, error) => {
          const recovery = await this.handleError(userId, error, {
            attempt,
            method: 'createConnection'
          });
          return recovery.shouldRetry;
        }
      });

      // Start client with proper error handling
      await this.startClient(userId, client);

      return client;

    } catch (error) {
      logger.error('[Matrix Service] Failed to create connection:', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  validateMatrixClient = async (userId) => {
    try {
      console.log('Matrix client validation attempt:', {
        userId,
        matrixUserId: this.matrixClients.get(userId)?.getUserId()
      });
      
      // Verify the response matches our expected user ID
      if (whoamiResponse?.user_id !== this.matrixClients.get(userId)?.getUserId()) {
        throw new Error('User ID mismatch in whoami response');
      }

      console.log('Matrix client validation successful:', {
        userId,
        matrixUserId: this.matrixClients.get(userId)?.getUserId(),
        whoamiUserId: whoamiResponse.user_id
      });
      
      return true;
    } catch (error) {
      console.error(`Matrix client validation attempt failed:`, {
        error: error.message,
        userId,
        matrixUserId: this.matrixClients.get(userId)?.getUserId()
      });

      if (attempt === MAX_RETRIES - 1) {
        // On final attempt, try to clean up
        this.matrixClients.delete(userId);
        throw new Error(`Matrix client validation failed after ${MAX_RETRIES} attempts: ${error.message}`);
      }
    }
    return false;
  }

  restoreSession = async ({ userId, matrixCredentials }) => {
    try {
      console.log('=== Starting Matrix Session Restoration ===');
      console.log('Step 1: Validating input parameters:', {
        userId,
        matrixUserId: matrixCredentials?.userId
      });

      if (!userId || !matrixCredentials?.userId || !matrixCredentials?.accessToken) {
        throw new Error('Missing required parameters for session restoration');
      }

      // Get stored account data
      console.log('Step 2: Fetching stored account data');
      const { data: accountData, error: accountError } = await adminClient
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (accountError || !accountData) {
        throw new Error('No Matrix account found for user');
      }

      // Initialize Matrix client with stored credentials
      console.log('Step 3: Creating Matrix client instance');
      const matrixClient = sdk.createClient({
        baseUrl: accountData.credentials.homeserver,
        accessToken: matrixCredentials.accessToken,
        userId: matrixCredentials.userId,
        deviceId: matrixCredentials.deviceId,
        timeoutMs: 30000,
        retryIf: (attempt, error) => {
          console.log(`Matrix client retry attempt ${attempt}:`, error.message);
          return attempt < 3 && (
            error.name === 'ConnectionError' ||
            error.errcode === 'M_LIMIT_EXCEEDED' ||
            error.name === 'TimeoutError'
          );
        }
      });

      // Store client in memory first
      console.log('Step 4: Storing Matrix client in memory');
      this.matrixClients.set(userId, matrixClient);

      // Then validate the client
      console.log('Step 5: Validating Matrix client');
      await this.validateMatrixClient(userId);

      console.log('=== Matrix Session Restoration Completed Successfully ===');
      return {
        status: 'success',
        message: 'Matrix session restored successfully',
        data: {
          userId: matrixCredentials.userId,
          homeserver: accountData.credentials.homeserver,
          bridgeRoomId: accountData.credentials.bridge_room_id
        }
      };
    } catch (error) {
      // If validation fails, remove the client from memory
      this.matrixClients.delete(userId);

      console.error('=== Matrix Session Restoration Failed ===');
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        userId,
        matrixUserId: matrixCredentials?.userId
      });
      throw error;
    }
  }

  initialize = async ({ userId, credentials, authToken }) => {
    try {
      // Track initialization state
      this.updateConnectionState(userId, 'initializing');
      
      // Validate and prepare Matrix client
      const client = await this.initializeClient(userId, credentials);
      if (!client) {
        throw new Error('Failed to initialize Matrix client');
      }

      // Check for existing bridge room
      let bridgeRoom = await this.getBridgeRoom(userId);
      
      // If no bridge room exists, handle bot invitation
      if (!bridgeRoom) {
        bridgeRoom = await this.handleBotInvite(userId, null);
        if (!bridgeRoom) {
          throw new Error('Failed to create bridge room');
        }
      }

      // Validate bridge room state
      const isValid = await this.validateBridgeRoomWithRetry(userId, bridgeRoom.roomId);
      if (!isValid) {
        throw new Error('Bridge room validation failed');
      }

      // Setup message sync and listeners
      await this.setupMessageSync(userId, client);
      await this.setupTimelineListeners(userId, client);

      // Start health checks
      this.startHealthCheck(userId, client);

      // Update connection state
      this.updateConnectionState(userId, 'ready');

      return {
        status: 'success',
        bridgeRoomId: bridgeRoom.roomId
      };

    } catch (error) {
      logger.error('[Matrix Service] Initialization failed:', {
        userId,
        error: error.message
      });
      
      this.updateConnectionState(userId, 'error', error);
      throw error;
    }
  }

  async connectWhatsApp(userId) {
    try {
      // Get Matrix client
      const client = await this.getMatrixClientWithRetry(userId);
      if (!client) {
        throw new Error('Matrix client not available');
      }

      // Get or create bridge room
      let bridgeRoom = await this.getBridgeRoom(userId);
      if (!bridgeRoom) {
        bridgeRoom = await this.handleBotInvite(userId);
        if (!bridgeRoom) {
          throw new Error('Failed to create bridge room');
        }
      }

      // Setup connection tracking
      const connectionKey = `whatsapp:${userId}`;
      const connection = {
        userId,
        bridgeRoomId: bridgeRoom.roomId,
        status: 'connecting',
        startTime: Date.now(),
        retryCount: 0
      };

      this.connections.set(connectionKey, connection);

      // Setup event listeners for QR code and connection status
      const cleanup = () => {
        client.removeListener('Room.timeline', timelineHandler);
        clearTimeout(setupTimeout);
      };

      const timelineHandler = (event, room) => {
        if (room.roomId !== bridgeRoom.roomId) return;

        const content = event.getContent();
        const msgtype = content.msgtype;

        if (msgtype === 'm.image' && content.body?.includes('QR code')) {
          this.emitStatusUpdate(userId, 'qr_ready', bridgeRoom.roomId);
        } else if (content.body?.includes('WhatsApp connection successful')) {
          cleanup();
          this.updateConnectionStatus(userId, 'connected', bridgeRoom.roomId);
          this.startSyncProcess(userId);
        } else if (content.body?.includes('WhatsApp connection failed')) {
          cleanup();
          this.updateConnectionStatus(userId, 'failed', bridgeRoom.roomId, {
            error: 'Connection failed',
            details: content.body
          });
        }
      };

      client.on('Room.timeline', timelineHandler);

      // Set timeout for setup
      const setupTimeout = setTimeout(() => {
        cleanup();
        this.updateConnectionStatus(userId, 'timeout', bridgeRoom.roomId);
      }, 300000); // 5 minutes

      // Start connection process
      await this.sendBridgeCommand(client, bridgeRoom.roomId, 'start');

      return bridgeRoom;

    } catch (error) {
      logger.error('[Matrix Service] WhatsApp connection failed:', {
        userId,
        error: error.message
      });
      
      this.updateConnectionStatus(userId, 'error', null, {
        error: error.message
      });
      
      throw error;
    }
  }

  async startSyncProcess(userId, options = {}) {
    const retryCount = options.retryCount || 0;
    const syncKey = `sync:${userId}`;

    try {
      // Initialize sync state
      await this.updateSyncProgress(userId, {
        state: 'initializing',
        progress: 0,
        startTime: Date.now()
      });

      // Get Matrix client
      const client = await this.getMatrixClientWithRetry(userId);
      if (!client) {
        throw new Error('Matrix client not available');
      }

      // Try to get saved sync token
      const savedToken = await this.getSavedSyncToken(userId);
      
      // Start client with appropriate sync options
      await client.startClient({
        initialSyncLimit: savedToken ? undefined : 10,
        includeArchivedRooms: false,
        lazyLoadMembers: true,
        syncToken: savedToken
      });

      // Wait for sync with improved error handling
      await this.waitForSync(userId, client, {
        isInitial: !savedToken,
        retryCount
      });

      // Update sync state on success
      await this.updateSyncProgress(userId, {
        state: 'ready',
        progress: 100,
        lastSync: Date.now()
      });

      return true;

    } catch (error) {
      const shouldRetry = retryCount < SYNC_CONFIGS.MAX_RETRIES;
      
      await this.updateSyncProgress(userId, {
        state: shouldRetry ? 'retrying' : 'error',
        error: error.message,
        retryCount,
        lastAttempt: Date.now()
      });

      if (shouldRetry) {
        const backoff = Math.min(
          SYNC_CONFIGS.BASE_BACKOFF * Math.pow(2, retryCount),
          SYNC_CONFIGS.MAX_BACKOFF
        );
        
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.startSyncProcess(userId, { retryCount: retryCount + 1 });
      }
      
      throw error;
    }
  }

  async syncContacts(userId, client) {
    return this.lockManager.withLock(`matrix:contacts:${userId}`, async () => {
      // Get all WhatsApp rooms
      const rooms = await this.getWhatsAppRooms(client);
      
      // Process rooms in batches to avoid overwhelming the system
      const batchSize = 10;
      for (let i = 0; i < rooms.length; i += batchSize) {
        const batch = rooms.slice(i, i + batchSize);
        await Promise.all(batch.map(room => this.processContactRoom(userId, room)));
        
        // Update sync progress
        const progress = Math.min(100, Math.round((i + batchSize) / rooms.length * 100));
        this.updateSyncProgress(userId, 'contacts', progress);
      }
    });
  }

  updateConnectionStatus = async (userId, status, bridgeRoomId = null, options = {}) => {
    const lockKey = `whatsapp:status:${userId}`;
    
    try {
      // Acquire lock first
      const lock = await this.redisLock.acquire(lockKey, 30000); // 30s timeout
      
      logger.info('[Matrix Service] Status update requested:', {
        userId,
        currentStatus: status,
        bridgeRoomId,
        timestamp: new Date().toISOString(),
        options
      });

      // Get current account state
      const { data: existingAccount } = await adminClient
        .from('accounts')
        .select('status, credentials, metadata')
        .eq('user_id', userId)
        .eq('platform', 'whatsapp')
        .single();

      // Handle error state separately from inactive
      if (status === CONNECTION_STATES.ERROR) {
        const errorMetadata = {
          lastError: options.error || 'Unknown error',
          errorType: options.errorType || ERROR_TYPES.RECOVERABLE,
          errorTimestamp: new Date().toISOString(),
          isRecoverable: options.isRecoverable !== false
        };

        await this.updateAccountState(userId, {
          status: CONNECTION_STATES.ERROR,
          metadata: {
            ...(existingAccount?.metadata || {}),
            errors: [
              ...(existingAccount?.metadata?.errors || []).slice(-4),
              errorMetadata
            ]
          }
        });

        logger.error('[Matrix Service] Connection error recorded:', {
          userId,
          error: errorMetadata
        });

        await this.emitStatusUpdate(userId, CONNECTION_STATES.ERROR, bridgeRoomId);
        return true;
      }

      // If attempting to set inactive, validate carefully
      if (status !== CONNECTION_STATES.ACTIVE && bridgeRoomId) {
        // Try multiple times for sync issues
        const isValid = await this.validateBridgeRoomWithRetry(userId, bridgeRoomId);
        
        if (isValid) {
          logger.warn('[Matrix Service] Prevented incorrect inactive status - bridge room still valid', {
            userId,
            bridgeRoomId
          });
          return true;
        }
      }

      // Determine final status
      const finalStatus = bridgeRoomId ? CONNECTION_STATES.ACTIVE : CONNECTION_STATES.INACTIVE;

      // Only update if status actually changed
      if (existingAccount?.status !== finalStatus) {
        await this.updateAccountState(userId, {
          status: finalStatus,
          platform_user_id: bridgeRoomId || null,
          metadata: {
            ...(existingAccount?.metadata || {}),
            lastStatusChange: {
              from: existingAccount?.status,
              to: finalStatus,
              timestamp: new Date().toISOString(),
              reason: options.reason || 'explicit_update'
            }
          }
        });

        logger.info('[Matrix Service] Status updated:', {
          userId,
          oldStatus: existingAccount?.status,
          newStatus: finalStatus,
          bridgeRoomId,
          reason: options.reason
        });

        await this.emitStatusUpdate(userId, finalStatus, bridgeRoomId);
      }

      return true;
    } catch (error) {
      logger.error('[Matrix Service] Error updating connection status:', {
        userId,
        error,
        attempted_status: status
      });
      throw error;
    } finally {
      // Release lock
      await this.redisLock.release(lockKey).catch(error => {
        logger.error('[Matrix Service] Error releasing lock:', {
          userId,
          error
        });
      });
    }
  }

  updateAccountState = async (userId, updates) => {
    const { error } = await adminClient
      .from('accounts')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('platform', 'whatsapp');

    if (error) {
      logger.error('[Matrix Service] Failed to update account:', {
        userId,
        updates,
        error
      });
      throw error;
    }
  }

  validateBridgeRoomWithRetry = async (userId, bridgeRoomId, maxAttempts = 3) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const matrixClient = this.matrixClients.get(userId);
        if (!matrixClient) return false;

        // Wait for sync if needed
        if (!matrixClient.isInitialSyncComplete()) {
          await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 5000);
            matrixClient.once('sync', (state) => {
              clearTimeout(timeout);
              resolve(state === 'PREPARED');
            });
          });
        }

        const room = matrixClient.getRoom(bridgeRoomId);
        if (!room) return false;

        // Check bridge bot presence using configured ID
        const bridgeBotId = BRIDGE_CONFIGS.whatsapp.bridgeBot;
        const members = room.getJoinedMembers();
        const botPresent = members.some(member => member.userId === bridgeBotId);

        logger.debug('[Matrix Service] Bridge room validation:', {
          userId,
          bridgeRoomId,
          attempt,
          botPresent,
          memberCount: members.length
        });

        return botPresent;

      } catch (error) {
        logger.warn('[Matrix Service] Validation attempt failed:', {
          userId,
          bridgeRoomId,
          attempt,
          error: error.message
        });

        if (attempt === maxAttempts) return false;
        await sleep(1000 * attempt);
      }
    }

    return false;
  }

  emitStatusUpdate = async (userId, status, bridgeRoomId) => {
    const statusData = {
      status,
      bridgeRoomId,
      timestamp: new Date().toISOString()
    };

    const io = getIO();
    if (io) {
      await io.to(`user:${userId}`).emit('whatsapp:status_update', {
        userId,
        ...statusData
      });
    }

    // Backup emission through Redis
    ioEmitter.emit('whatsapp:status_update', {
      userId,
      ...statusData
    });
  }

  disconnectWhatsApp = async (userId) => {
    try {
      const connection = this.connections.get(userId);
      if (!connection) {
        throw new Error('No active WhatsApp connection found');
      }

      // Update status in memory first
      connection.status = 'inactive';

      const { matrixClient, bridgeRoomId } = connection;

      // Send logout command
      await matrixClient.sendMessage(bridgeRoomId, {
        msgtype: 'm.text',
        body: BRIDGE_CONFIGS.whatsapp.logoutCommand
      });

      // Update account status to inactive
      await this.updateConnectionStatus(userId, 'inactive');

      // Clean up connection
      this.connections.delete(userId);

      return true;
    } catch (error) {
      console.error('[Matrix Service] Error disconnecting WhatsApp:', error);
      throw error;
    }
  }

  checkBotPresence = async (matrixClient, bridgeRoomId) => {
    try {
      if (!matrixClient || !bridgeRoomId) {
        console.log('[Matrix Service] Invalid parameters for bot presence check:', {
          hasClient: !!matrixClient,
          roomId: bridgeRoomId
        });
        return false;
      }

      const room = matrixClient.getRoom(bridgeRoomId);
      if (!room) {
        console.log('[Matrix Service] Bridge room not found:', bridgeRoomId);
        return false;
      }

      const bridgeBot = room.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
      if (!bridgeBot || bridgeBot.membership !== 'join') {
        console.log('[Matrix Service] Bridge bot not present or not joined:', {
          roomId: bridgeRoomId,
          botPresent: !!bridgeBot,
          membership: bridgeBot?.membership
        });
        return false;
      }

      return true;
    } catch (error) {
      console.error('[Matrix Service] Error checking bot presence:', error);
      return false;
    }
  }

  cleanupStaleConnection = async (userId, bridgeRoomId) => {
    try {
      console.log('[Matrix Service] Cleaning up stale connection:', {
        userId,
        bridgeRoomId
      });

      // Remove in-memory connection
      this.connections.delete(userId);
      
      // Update database status to inactive
                await this.updateConnectionStatus(userId, 'inactive');
      
      // Clear connection attempts
      this.connectionAttempts.delete(userId);

      // Update account record with empty credentials object (as JSONB)
      const { error: updateError } = await adminClient
        .from('accounts')
        .update({
          status: 'inactive',
          credentials: {},  // Pass as object, not string, for JSONB
          platform_user_id: null,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('platform', 'whatsapp');

      if (updateError) {
        console.error('[Matrix Service] Error updating account record:', updateError);
        throw updateError;
      }

      return true;
          } catch (error) {
      console.error('[Matrix Service] Error cleaning up stale connection:', error);
      throw error;
    }
  }

  getStatus = async (userId) => {
    try {
      console.log('Getting WhatsApp status for user:', userId);
      
      // Get Matrix client
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        return { status: 'error', error: 'Matrix client not initialized' };
      }

      // Get bridge room
      const bridgeRoom = await this.getBridgeRoom(userId);
      if (!bridgeRoom) {
        return { status: 'inactive', bridgeRoomId: null };
      }

      // Check if bridge bot is still in the room
      const members = bridgeRoom.getJoinedMembers();
      const bridgeBotPresent = members.some(member => 
        member.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot
      );

      if (!bridgeBotPresent) {
        return { status: 'error', error: 'Bridge bot not found in room' };
      }

      // Get WhatsApp connection status from room state
      const whatsappState = bridgeRoom.currentState.getStateEvents('m.room.whatsapp')[0];
      const isConnected = whatsappState?.getContent()?.connected === true;

      return {
        status: isConnected ? 'active' : 'pending',
        bridgeRoomId: bridgeRoom.roomId
      };
    } catch (error) {
      console.error('Error getting WhatsApp status:', error);
      return { status: 'error', error: error.message };
    }
  }

  getStatusMessage = (status, connection) => {
    switch (status) {
      case 'active':
        return connection ? 'WhatsApp connection is active' : 'WhatsApp connection needs restoration';
      case 'inactive':
        return 'WhatsApp is not connected';
      case 'reconnecting':
        return 'Restoring WhatsApp connection';
      case 'error':
        return 'WhatsApp connection error';
      default:
        return 'Unknown WhatsApp connection state';
    }
  }

  setupMessageSync = async (userId, matrixClient) => {
    console.log('Setting up Matrix message sync for user:', userId);
    
    try {
      // Get all WhatsApp contacts for the user to build room mapping
      const { data: contacts, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id, metadata')
        .eq('user_id', userId);

      if (contactError) throw contactError;

      // Build room to contact mapping
      contacts.forEach(contact => {
        if (contact.metadata?.room_id) {
          this.roomToContactMap.set(contact.metadata.room_id, {
            contactId: contact.id,
            whatsappId: contact.whatsapp_id
          });
        }
      });

      // Set up socket connection with heartbeat
      const io = getIO();
      if (io) {
        const socket = io.sockets.sockets.get(`user:${userId}`);
        if (socket) {
          // Setup heartbeat
          const heartbeat = setInterval(() => {
            if (socket.connected) {
              socket.emit('whatsapp:heartbeat');
            } else {
              clearInterval(heartbeat);
            }
          }, 30000); // 30 second heartbeat

          // Handle reconnection
          socket.on('disconnect', () => {
            clearInterval(heartbeat);
            // Store pending updates
            this.storePendingUpdates(userId);
          });

          socket.on('reconnect', () => {
            // Restore pending updates
            this.restorePendingUpdates(userId);
          });
        }
      }

      // Set up timeline listener for all rooms
      matrixClient.on('Room.timeline', async (event, room, toStartOfTimeline) => {
        try {
          // Skip if not a WhatsApp room
          const contactInfo = this.roomToContactMap.get(room.roomId);
          if (!contactInfo) return;

          // Process message with retries
          let retryCount = 0;
          while (retryCount < 3) {
            try {
              await this.processMessage(userId, contactInfo.contactId, event);
              break;
            } catch (err) {
              retryCount++;
              if (retryCount === 3) throw err;
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          logger.error('[Matrix Service] Error processing timeline event:', {
            userId,
            roomId: room.roomId,
            error: error.message
          });
        }
      });

      logger.info('[Matrix Service] Message sync setup completed for user:', userId);
    } catch (error) {
      logger.error('[Matrix Service] Error in setupMessageSync:', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  async storePendingUpdates(userId) {
    try {
      const pendingUpdates = this.pendingUpdates.get(userId) || [];
      if (pendingUpdates.length > 0) {
        await pubClient.set(
          `pending:${userId}`,
          JSON.stringify(pendingUpdates),
          'EX',
          86400 // Store for 24 hours
        );
      }
    } catch (error) {
      logger.error('[Matrix Service] Error storing pending updates:', {
        userId,
        error: error.message
      });
    }
  }

  async restorePendingUpdates(userId) {
    try {
      const pendingData = await pubClient.get(`pending:${userId}`);
      if (pendingData) {
        const updates = JSON.parse(pendingData);
        const io = getIO();
        if (io) {
          updates.forEach(update => {
            io.to(`user:${userId}`).emit(update.event, update.data);
          });
        }
        await pubClient.del(`pending:${userId}`);
      }
    } catch (error) {
      logger.error('[Matrix Service] Error restoring pending updates:', {
        userId,
        error: error.message
      });
    }
  }

  syncMessages = async (userId, contactId, retryCount = 0) => {
    const syncKey = `sync:${userId}:${contactId}`;
    let currentBatchRetries = 0;
    const MAX_BATCH_RETRIES = 3;
    
    try {
      // Check for existing sync state
      const existingState = await pubClient.get(syncKey);
      if (existingState) {
        const state = JSON.parse(existingState);
        if (state.state === SYNC_STATES.PROCESSING || state.state === SYNC_STATES.RETRYING) {
          console.log('[Matrix Service] Sync already in progress:', state);
          return state;
        }
      }

      // Initialize sync state
      await this.updateSyncProgress(userId, {
        state: SYNC_STATES.PREPARING,
        progress: 0,
        startedAt: Date.now(),
        totalMessages: 0,
        processedMessages: 0,
        errors: [],
        retryCount,
        batchRetries: 0
      });

      // ... rest of existing sync logic ...

      // Handle offline scenario
      if (!global.io?.sockets?.adapter?.rooms?.get(`user:${userId}`)) {
        await this.updateSyncProgress(syncKey, {
          state: SYNC_STATES.OFFLINE,
          details: 'User offline, sync will resume when online'
        });
        return;
      }

      // ... rest of existing sync logic ...

    } catch (error) {
      const errorType = getErrorType(error);
      
      // Update sync state with error
      await this.updateSyncProgress(syncKey, {
        state: SYNC_STATES.ERROR,
        error: error.message,
        errorType,
        completedAt: Date.now()
      });

      throw error;
    }
  }

  processMessageEvent = async (userId, contactId, event) => {
    // Skip messages from bridge bot
    if (event.getSender() === BRIDGE_CONFIGS.whatsapp.bridgeBot) {
      console.log('[Matrix Service] Skipping bridge bot message:', event.getId());
      return null;
    }

    const content = event.getContent();
    
    // Skip bot commands and responses
    if (content.body && (content.body.startsWith('!wa') || content.body.startsWith('Successfully logged in'))) {
      console.log('[Matrix Service] Skipping bot command/response:', event.getId());
      return null;
    }

    console.log('[Matrix Service] Processing message event:', {
      eventId: event.getId(),
      type: content.msgtype,
      timestamp: event.getTs()
    });

    const messageData = {
      user_id: userId,
      contact_id: contactId,
      message_id: event.getId(),
      content: content.body || JSON.stringify(content),
      sender_id: event.getSender(),
      timestamp: new Date(event.getTs()).toISOString(),
      is_read: false,
      message_type: content.msgtype === 'm.text' ? 'text' : 'media',
      metadata: {
        raw_event: {
          type: event.getType(),
          content: content,
          origin_server_ts: event.getTs()
        }
      }
    };

    const { error: insertError } = await adminClient
      .from('whatsapp_messages')
      .upsert(messageData, {
        onConflict: 'user_id,message_id'
      });

    if (insertError) {
      throw insertError;
    }

    return messageData;
  }

  updateSyncStatus = async (userId, contactId, status, error = null) => {
    try {
      // Validate status against allowed values
      const validStatuses = ['pending', 'approved', 'rejected'];
      if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
      }

      // Get current sync request
      const { data: currentSync, error: fetchError } = await adminClient
        .from('whatsapp_sync_requests')
        .select('status, metadata')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .single();

      if (fetchError && !fetchError.message.includes('not found')) {
        console.error('[Matrix Service] Error fetching current sync status:', fetchError);
        throw fetchError;
      }

      // Prepare metadata
      const metadata = {
        ...(currentSync?.metadata || {}),
        last_updated: new Date().toISOString(),
        is_processing: status === 'pending'
      };

      if (error) {
        metadata.error = error.message;
        metadata.failed_at = new Date().toISOString();
      }

      if (status === 'approved') {
        metadata.sync_completed_at = new Date().toISOString();
        metadata.is_processing = false;
      }

      // Update sync status with metadata
      const { error: updateError } = await adminClient
        .from('whatsapp_sync_requests')
        .upsert({
          user_id: userId,
          contact_id: contactId,
          status,
          approved_at: status === 'approved' ? new Date().toISOString() : null,
          metadata
        }, {
          onConflict: 'user_id,contact_id'
        });

      if (updateError) {
        console.error('[Matrix Service] Failed to update sync status:', updateError);
        throw updateError;
      }

      console.log(`[Matrix Service] Sync status updated to ${status} for contact ${contactId}`);
    } catch (error) {
      console.error('[Matrix Service] Error in updateSyncStatus:', error);
      throw error;
    }
  }

  getMatrixClient = async (userId) => {
    try {
      // Check active connections first
      let connection = this.connectionPool.active.get(userId);
      if (connection?.client) {
        connection.lastUsed = Date.now();
        return connection.client;
      }

      // Check idle connections
      connection = this.connectionPool.idle.get(userId);
      if (connection?.client) {
        // Move to active pool
        this.connectionPool.idle.delete(userId);
        connection.lastUsed = Date.now();
        this.connectionPool.active.set(userId, connection);
        return connection.client;
      }

      // Check connection pool limits
      if (this.connectionPool.active.size >= this.connectionPool.MAX_ACTIVE) {
        throw new Error('Connection pool limit reached');
      }

      // Get valid token with rate limiting
      const tokenLimitResult = await this.tokenLimiter.get({ id: userId });
      if (!tokenLimitResult.remaining) {
        const retryAfter = Math.ceil((tokenLimitResult.reset - Date.now()) / 1000);
        throw new Error(`Token refresh rate limit exceeded. Retry after ${retryAfter} seconds`);
      }

      const tokenData = await tokenService.getValidToken();
      if (!tokenData?.access_token) {
        throw new Error('No valid access token available');
      }

      // Validate required credentials
      const homeserver = process.env.MATRIX_SERVER_URL;
      const matrixUserId = `@${userId}:${process.env.MATRIX_SERVER_DOMAIN}`;

      if (!homeserver || !matrixUserId) {
        logger.error('[Matrix Service] Invalid Matrix configuration:', {
          hasHomeserver: !!homeserver,
          hasMatrixUserId: !!matrixUserId
        });
        throw new Error('Invalid Matrix configuration');
      }

      // Initialize new client with validated credentials
      const client = sdk.createClient({
        baseUrl: homeserver,
        accessToken: tokenData.access_token,
        userId: matrixUserId,
        timeoutMs: 10000,
        localTimeoutMs: 10000
      });

      // Enhanced token subscription with rate limiting
      const unsubscribe = tokenService.subscribe(async (newTokenData) => {
        try {
          const limitResult = await this.tokenLimiter.get({ id: userId });
          if (!limitResult.remaining) {
            logger.warn('[Matrix Service] Token refresh rate limited:', {
              userId,
              resetIn: Math.ceil((limitResult.reset - Date.now()) / 1000)
            });
            return;
          }

          client.setAccessToken(newTokenData.access_token);
          logger.info('[Matrix Service] Updated access token:', {
            userId,
            tokenExpiry: newTokenData.expires_at
          });
        } catch (error) {
          await this.handleError(userId, error, {
            context: 'token_update',
            tokenExpiry: newTokenData.expires_at
          });
        }
      });

      // Store in active pool
      this.connectionPool.active.set(userId, {
        client,
        unsubscribe,
        lastUsed: Date.now()
      });

      // Start client and wait for sync
      try {
        await client.startClient({
          initialSyncLimit: 10,
          lazyLoadMembers: true
        });

        await this.waitForSync(userId, client, {
          isInitial: true,
          retryCount: 0
        });

        this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);
        return client;

      } catch (error) {
        // Clean up on failure
        this.connectionPool.active.delete(userId);
        unsubscribe();
        
        logger.error('[Matrix Service] Failed to initialize Matrix client:', {
          userId,
          error: error.message
        });
        
        const recovery = await this.handleError(userId, error, {
          context: 'client_initialization'
        });
        
        if (recovery.shouldRetry) {
          await this.delay(recovery.backoffMs);
          return this.getMatrixClientWithRetry(userId);
        }
        
        throw error;
      }
    } catch (error) {
      logger.error('[Matrix Service] Error in getMatrixClient:', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  getMatrixClientWithRetry = async (userId, retryCount = 0) => {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 2000;

    try {
      return await this.getMatrixClient(userId);
    } catch (error) {
      if (retryCount >= MAX_RETRIES) {
        logger.error('[Matrix Service] Max retries exceeded for getting Matrix client:', {
          userId,
          retryCount,
          error: error.message
        });
        throw error;
      }

      const delay = BASE_DELAY * Math.pow(2, retryCount);
      await sleep(delay);
      
      logger.info('[Matrix Service] Retrying Matrix client initialization:', {
        userId,
        retryCount: retryCount + 1,
        delay
      });
      
      return this.getMatrixClientWithRetry(userId, retryCount + 1);
    }
  }

  restoreConnection = async (userId, credentials) => {
    try {
      console.log('Attempting to restore WhatsApp connection for user:', userId);
      
      // First validate/initialize Matrix client
      const matrixClient = await this.initializeMatrixClient(credentials);
      
      // Then attempt to restore WhatsApp connection
      await this.connectWhatsApp(userId);
      
      // Clear connection attempts on success
      this.connectionAttempts.delete(userId);
      
      return true;
    } catch (error) {
      console.error('Failed to restore connection:', error);
      throw error;
    }
  }

  handleBotInvite = async (userId, roomId) => {
    try {
      console.log('[Matrix] Handling bot invite for room:', roomId);
      
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get room state
      const room = matrixClient.getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }

      // Check if bridge bot is in the room
      const bridgeBot = room.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
      if (!bridgeBot) {
        throw new Error('Bridge bot not found in room');
      }

      // Skip if this is the bridge control room
      if (roomId === BRIDGE_CONFIGS.whatsapp.bridgeRoomId) {
        console.log('[Matrix] Skipping bridge control room:', roomId);
        return false;
      }

      // Check if this is a valid WhatsApp chat room
      const roomName = room.name;
      const isWhatsAppRoom = roomName && (
        roomName.includes('(WA)') || 
        roomName.match(/\+\d{10,}/) || 
        room.currentState.getStateEvents('m.room.whatsapp').length > 0
      );

      if (!isWhatsAppRoom) {
        console.log('[Matrix] Not a WhatsApp chat room, skipping:', roomId);
        return false;
      }

      // If bot is invited, accept the invite
      if (bridgeBot.membership === 'invite') {
        console.log('[Matrix] Accepting bot invite for WhatsApp room:', roomId);
        await matrixClient.joinRoom(roomId);
        
        // Wait for the join to complete
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Join timeout')), 10000);
          let attempts = 0;
          
          const checkJoin = async () => {
            const updatedRoom = matrixClient.getRoom(roomId);
            const updatedBot = updatedRoom?.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
            
            if (updatedBot?.membership === 'join') {
              clearTimeout(timeout);
              resolve();
            } else if (attempts > 10) {
              clearTimeout(timeout);
              reject(new Error('Max attempts reached waiting for bot join'));
            } else {
              attempts++;
              setTimeout(checkJoin, 1000);
            }
          };
          
          checkJoin();
        });

        // Update room status in database
        const { error: updateError } = await adminClient
          .from('whatsapp_contacts')
          .update({
            bridge_room_id: roomId,
            sync_status: 'approved',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('metadata->room_id', roomId);

        if (updateError) {
          console.error('[Matrix] Error updating contact after bot join:', updateError);
          throw updateError;
        }

        // Trigger initial sync for the room
        await this.syncMessages(userId, roomId);

        return true;
      }

      return false;
    } catch (error) {
      console.error('[Matrix] Error handling bot invite:', error);
      throw error;
    }
  }

  setMatrixClient = (userId, client) => {
    if (!userId || !client) {
      console.error('[Matrix Service] Invalid parameters for setMatrixClient:', { 
        hasUserId: !!userId, 
        hasClient: !!client 
      });
      return false;
    }
    
    try {
      this.matrixClients.set(userId, client);
      console.log('[Matrix Service] Successfully stored Matrix client for user:', userId);
      return true;
    } catch (error) {
      console.error('[Matrix Service] Error storing Matrix client:', error);
      return false;
    }
  }

  restoreMatrixClient = async (userId, credentials) => {
    try {
      console.log(`[Matrix Service] Restoring Matrix client for user ${userId}`);
      
      // Validate required credentials
      if (!credentials?.homeserver || !credentials?.userId) {
        console.error('[Matrix Service] Missing required Matrix credentials:', {
          hasHomeserver: !!credentials?.homeserver,
          hasAccessToken: !!credentials?.accessToken
        });
        return false;
      }

      // Create Matrix client using SDK
      const client = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: credentials.accessToken,
        userId: credentials.userId
      });

      // Start client and wait for sync
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Matrix sync timeout'));
        }, 30000);

        client.once('sync', (state) => {
          clearTimeout(timeout);
          if (state === 'PREPARED') {
            resolve();
          } else {
            reject(new Error(`Sync failed with state: ${state}`));
          }
        });

        client.startClient({ initialSyncLimit: 10 });
      });
      
      // Check if bot is present in the bridge room
      const botPresent = await this.checkBotPresence(client, credentials.bridge_room_id);
      if (!botPresent) {
        console.log(`[Matrix Service] Bot not found in bridge room for user ${userId}`);
        await client.stopClient();
        return false;
      }

      // Store the client and connection
      this.matrixClients.set(userId, client);
      this.connections.set(userId, {
        client,
        bridgeRoomId: credentials.bridge_room_id,
        status: 'active'
      });

      console.log(`[Matrix Service] Successfully restored connection for user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[Matrix Service] Error restoring Matrix client for user ${userId}:`, error);
      return false;
    }
  }

  getAccount = async (userId) => {
    try {
      console.log("[Matrix Service] Getting accounts for user:", userId);
      
      // Get both WhatsApp and Matrix accounts
      const { data: accounts, error } = await adminClient
        .from('accounts')
        .select('platform, status, credentials')
        .eq('user_id', userId)
        .in('platform', ['whatsapp', 'matrix']);

      if (error) throw error;

      // Find WhatsApp and Matrix accounts
      const whatsappAccount = accounts?.find(acc => acc.platform === 'whatsapp');
      const matrixAccount = accounts?.find(acc => acc.platform === 'matrix');
      
      console.log("[Matrix Service] Found accounts:", {
        hasWhatsApp: !!whatsappAccount,
        hasMatrix: !!matrixAccount,
        whatsappStatus: whatsappAccount?.status,
        hasBridgeRoom: !!whatsappAccount?.credentials?.bridge_room_id
      });

      // Combine credentials for client initialization
      const combinedAccount = whatsappAccount ? {
        ...whatsappAccount,
        credentials: {
          ...whatsappAccount.credentials,
          ...matrixAccount?.credentials
        }
      } : null;
      
      return combinedAccount;
    } catch (error) {
      console.error("[Matrix Service] Error fetching accounts:", error);
      throw error;
    }
  }

  setupTimelineListeners = async (userId, matrixClient) => {
    try {
      console.log('[Matrix Service] Setting up timeline listeners for user:', userId);
      
      // Get all WhatsApp contacts for the user to build room mapping
      const { data: contacts, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id, metadata')
        .eq('user_id', userId);

      if (contactError) throw contactError;

      // Build room to contact mapping
      contacts.forEach(contact => {
        if (contact.metadata?.room_id) {
          this.roomToContactMap.set(contact.metadata.room_id, {
            contactId: contact.id,
            whatsappId: contact.whatsapp_id
          });
        }
      });

      // Set up timeline listener for all rooms
      matrixClient.on('Room.timeline', async (event, room, toStartOfTimeline) => {
        try {
          // Skip if not a message event
          if (event.getType() !== 'm.room.message') return;
          
          // Skip if from bridge bot or self
          if (event.getSender() === BRIDGE_CONFIGS.whatsapp.bridgeBot ||
              event.getSender() === matrixClient.getUserId()) return;

          // Get contact info from room
          const contactInfo = this.roomToContactMap.get(room.roomId);
          if (!contactInfo) {
            console.log('[Matrix Service] No contact mapping found for room:', room.roomId);
            return;
          }

          const content = event.getContent();
          if (!content || !content.body) return;

          // Prepare message data
          const messageData = {
            user_id: userId,
            contact_id: contactInfo.contactId,
            message_id: event.getId(),
            content: content.body,
            sender_id: event.getSender(),
            sender_name: room.getMember(event.getSender())?.name || event.getSender(),
            message_type: content.msgtype === 'm.text' ? 'text' : 'media',
            metadata: {
              room_id: room.roomId,
              event_id: event.getId(),
              raw_event: event.event
            },
            timestamp: new Date(event.getTs()).toISOString(),
            is_read: false
          };

          // Store message in database with retry
          let retryCount = 0;
          while (retryCount < 3) {
            try {
              const { error: insertError } = await adminClient
                .from('whatsapp_messages')
                .upsert(messageData, {
                  onConflict: 'user_id,message_id',
                  returning: true
                });

              if (!insertError) {
                // Update sync status and emit event
                await this.updateSyncStatus(userId, contactInfo.contactId, 'approved');
                global.io?.to(`user:${userId}`).emit('whatsapp:message', messageData);
                break;
              }

              retryCount++;
              if (retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
              }
            } catch (err) {
              console.error('[Matrix Service] Error storing message (attempt ${retryCount + 1}):', err);
              retryCount++;
              if (retryCount === 3) throw err;
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          console.error('[Matrix Service] Error processing timeline event:', error);
        }
      });

      console.log('[Matrix Service] Timeline listeners setup completed for user:', userId);
    } catch (error) {
      console.error('[Matrix Service] Error setting up timeline listeners:', error);
      throw error;
    }
  }

  getContacts = async (userId) => {
    const CACHE_KEY = `whatsapp:${userId}:contacts`;
    const CACHE_DURATION = 300; // 5 minutes

    try {
      // Check cache first
      const cachedContacts = await pubClient.get(CACHE_KEY);
      if (cachedContacts) {
        const parsed = JSON.parse(cachedContacts);
        logger.info('-----cached contacts returned ----')
        // Return cached data if it's less than 5 minutes old
        if (Date.now() - parsed.timestamp < CACHE_DURATION * 1000) {
          return parsed.contacts;
        }
      }

      // Fetch fresh contacts
      const contacts = await this.fetchContactsFromMatrix(userId);
      
      // Cache with metadata
      const contactData = {
        contacts,
        timestamp: Date.now(),
        count: contacts.length
      };

      // Set cache with expiration
      await pubClient.set(
        CACHE_KEY,
        JSON.stringify(contactData),
        'EX',
        CACHE_DURATION
      );

      // Set a secondary index for quick contact count
      await pubClient.set(
        `whatsapp:${userId}:contact_count`,
        contacts.length,
        'EX',
        CACHE_DURATION
      );

      return contacts;
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
      // Return cached data if available, even if expired
      const staleCache = await pubClient.get(CACHE_KEY);
      if (staleCache) {
        return JSON.parse(staleCache).contacts;
      }
      throw error;
    }
  }

  updateContact = async (userId, contactId, updates) => {
    try {
      const result = await this.updateContactInMatrix(userId, contactId, updates);
      
      // Invalidate contact cache
      await pubClient.del(`whatsapp:${userId}:contacts`);
      await pubClient.del(`whatsapp:${userId}:contact_count`);
      
      return result;
    } catch (error) {
      console.error('Failed to update contact:', error);
      throw error;
    }
  }

  // Get bridge room for a user
  getBridgeRoom = async (userId) => {
    try {
      // First check if we have it cached
      if (this.bridgeRooms.has(userId)) {
        return this.bridgeRooms.get(userId);
      }

      // Get the Matrix client
      const matrixClient = this.matrixClients.get(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get user's rooms
      const rooms = matrixClient.getRooms();
      
      // Find the bridge room
      const bridgeRoom = rooms.find(room => {
        const members = room.getJoinedMembers();
        return members.some(member => member.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot) &&
               room.name?.includes('WhatsApp Bridge');
      });

      if (bridgeRoom) {
        // Cache it for future use
        this.bridgeRooms.set(userId, bridgeRoom);
        return bridgeRoom;
      }

      return null;
    } catch (error) {
      console.error('Error getting bridge room:', error);
      return null;
    }
  }

  // Helper method to update sync progress in Redis
  updateSyncProgress = async (syncKey, updates) => {
    try {
      // Get current state with error handling
      let state = {};
      try {
        const currentState = await pubClient.get(syncKey);
        state = currentState ? JSON.parse(currentState) : {};
      } catch (error) {
        console.error('Error parsing sync state:', error);
      }

      // Merge updates with validation
      const newState = {
        ...state,
        ...updates,
        lastUpdated: Date.now()
      };

      // Validate progress is a number between 0-100
      if ('progress' in updates) {
        newState.progress = Math.max(0, Math.min(100, Number(updates.progress) || 0));
      }

      // Special handling for errors array with deduplication
      if (updates.errors) {
        const existingErrors = new Set(state.errors?.map(e => JSON.stringify(e)) || []);
        const newErrors = updates.errors.filter(e => !existingErrors.has(JSON.stringify(e)));
        newState.errors = [...(state.errors || []), ...newErrors];
      }

      // Set TTL based on state
      let ttl = 3600; // Default 1 hour
      if (newState.state === SYNC_STATES.COMPLETED) {
        ttl = 86400; // Keep completed states for 24 hours
      } else if (newState.state === SYNC_STATES.ERROR) {
        ttl = 43200; // Keep error states for 12 hours
      } else if (newState.state === SYNC_STATES.OFFLINE) {
        ttl = 604800; // Keep offline states for 7 days
      }

      // Store updated state with TTL
      await pubClient.set(syncKey, JSON.stringify(newState), 'EX', ttl);

      // Emit state update via socket if connected
      if (updates.state || updates.progress) {
        const [, userId, contactId] = syncKey.split(':');
        const io = getIO();
        const socket = io?.sockets?.adapter?.rooms?.get(`user:${userId}`);
        
        if (socket) {
          io.to(`user:${userId}`).emit('whatsapp:sync_state', {
            contactId,
            ...newState
          });
        } else {
          // Store offline updates for later
          const offlineKey = `offline:${userId}:${contactId}`;
          await pubClient.set(offlineKey, JSON.stringify({
            type: 'sync_state',
            data: newState,
            timestamp: Date.now()
          }), 'EX', 604800); // Store for 7 days
        }
      }

      return newState;
    } catch (error) {
      console.error('Error updating sync progress:', error);
      throw error;
    }
  }

  // New method to handle offline updates when user comes back online
  processOfflineUpdates = async (userId) => {
    try {
      // Get all offline updates for user
      const offlineKeys = await pubClient.keys(`offline:${userId}:*`);
      
      for (const key of offlineKeys) {
        const update = await pubClient.get(key);
        if (update) {
          const { type, data, timestamp } = JSON.parse(update);
          
          // Emit stored update
          global.io?.to(`user:${userId}`).emit(`whatsapp:${type}`, data);
          
          // Clean up processed update
          await pubClient.del(key);
        }
      }
    } catch (error) {
      console.error('Error processing offline updates:', error);
    }
  }

  initializeMatrixClient = async (credentials) => {
    const userId = credentials.userId;
    this.updateConnectionState(userId, CONNECTION_STATES.INITIALIZING);

    try {
      // Validate required credentials
      if (!credentials?.homeserver || !credentials?.userId) {
        throw new Error('Invalid Matrix credentials - missing homeserver or userId');
      }

      // Get valid token using token service
      const tokens = await tokenService.getValidToken();
      if (!tokens?.access_token) {
        throw new Error('No valid token available from token service');
      }

      // Initialize client with enhanced retry logic
      const client = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: tokens.access_token,
        userId: credentials.userId,
        timeoutMs: 60000,
        useAuthorizationHeader: true,
        retryIf: async (attempt, error) => {
          const recovery = await this.handleError(userId, error, {
            attempt,
            method: 'initializeMatrixClient'
          });

          return recovery.shouldRetry;
        }
      });

      // Subscribe to token updates
      const unsubscribe = tokenService.subscribe(async (newTokens) => {
        if (client && newTokens?.access_token) {
          logger.info('[Matrix Client] Updating client with new token');
          client.setAccessToken(newTokens.access_token);
          this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);
          // Reset auth error count on successful token update
          this.resetErrorCount(userId, ERROR_TYPES.AUTH);
        }
      });

      client._tokenUnsubscribe = unsubscribe;

      this.updateConnectionState(userId, CONNECTION_STATES.CONNECTING);

      // Enhanced sync initialization with error boundaries
      await new Promise((resolve, reject) => {
        const syncTimeout = setTimeout(() => {
          reject(new Error('Matrix sync initialization timeout'));
        }, 30000);

        client.once('sync', async (state, prevState, res) => {
          clearTimeout(syncTimeout);
          if (state === 'PREPARED') {
            resolve();
            // Reset sync error count on successful sync
            this.resetErrorCount(userId, ERROR_TYPES.SYNC);
          } else {
            const error = new Error(`Matrix sync failed: ${state}`);
            const recovery = await this.handleError(userId, error, {
              state,
              prevState,
              method: 'sync'
            });
            reject(error);
          }
        });

        client.startClient({ initialSyncLimit: 20 }).catch(async (error) => {
          const recovery = await this.handleError(userId, error, {
            method: 'startClient'
          });
          reject(error);
        });
      });

      this.startHealthCheck(userId, client);
      this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);
      return client;
    } catch (error) {
      const recovery = await this.handleError(userId, error, {
        method: 'initializeMatrixClient',
        credentials: {
          ...credentials,
          accessToken: '[REDACTED]'
        }
      });

      this.updateConnectionState(userId, CONNECTION_STATES.ERROR, error);
      throw error;
    }
  }

  validateMatrixToken = async (token) => {
    try {
      // First use token service validation
      if (!tokenService.validateToken(token)) {
        logger.warn('[Matrix Service] Token failed local validation');
        return false;
      }

      // Then verify with Matrix server
      const response = await fetch(`${process.env.MATRIX_HOMESERVER}/_matrix/client/v3/account/whoami`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status === 200) {
        return true;
      }

      if (response.status === 401) {
        // Token is invalid, try refreshing
        try {
          const newTokens = await tokenService.refreshToken();
          return !!newTokens?.access_token;
        } catch (refreshError) {
          logger.error('[Matrix Service] Token refresh failed:', refreshError);
          return false;
        }
      }

      return false;
    } catch (error) {
      logger.error('[Matrix Service] Token validation error:', error);
      return false;
    }
  }

  getConnectionState = (userId) => {
    return this.connectionStates.get(userId) || {
      state: CONNECTION_STATES.DISCONNECTED,
      health: CONNECTION_HEALTH.UNHEALTHY,
      lastActivity: null,
      error: null
    };
  }

  updateConnectionState = (userId, state, error = null) => {
    const currentState = this.getConnectionState(userId);
    const newState = {
      ...currentState,
      state,
      lastActivity: Date.now(),
      error: error ? { message: error.message, type: getErrorType(error) } : null
    };
    
    this.connectionStates.set(userId, newState);
    
    // Emit state change for monitoring
    ioEmitter.emit('matrix:state_change', {
      userId,
      state: newState
    });

    logger.info('[Matrix Service] Connection state updated:', {
      userId,
      state: newState.state,
      error: newState.error
    });
  }

  checkClientHealth = async (client) => {
    try {
      // Verify client is still connected and syncing
      if (!client || !client.clientRunning || client.getSyncState() !== 'SYNCING') {
        return false;
      }

      // Verify token is still valid
      const tokens = await tokenService.getValidToken();
      if (!tokens?.access_token) {
        return false;
      }

      // Additional health checks
      const whoamiPromise = client.whoami();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), 5000)
      );
      
      await Promise.race([whoamiPromise, timeoutPromise]);
      return true;
    } catch (error) {
      const userId = client?.credentials?.userId;
      if (userId) {
        await this.handleError(userId, error, {
          method: 'checkClientHealth',
          clientState: client?.getSyncState(),
          lastActivity: this.getConnectionState(userId)?.lastActivity
        });
      }
      return false;
    }
  }

  startHealthCheck = (userId, client) => {
    if (this.healthCheckIntervals.has(userId)) {
      clearInterval(this.healthCheckIntervals.get(userId));
    }

    const interval = setInterval(async () => {
      try {
        const state = this.getConnectionState(userId);
        
        // Skip health check if disconnected
        if (state.state === CONNECTION_STATES.DISCONNECTED) {
          return;
        }

        // Check client health
        const isHealthy = await this.checkClientHealth(client);
        const timeSinceLastActivity = Date.now() - state.lastActivity;
        
        let health = CONNECTION_HEALTH.HEALTHY;
        if (!isHealthy) {
          health = CONNECTION_HEALTH.UNHEALTHY;
        } else if (timeSinceLastActivity > this.HEALTH_CHECK_INTERVAL) {
          health = CONNECTION_HEALTH.DEGRADED;
        }

        // Update state with health status
        const newState = {
          ...state,
          health,
          lastActivity: isHealthy ? Date.now() : state.lastActivity,
          lastHealthCheck: Date.now()
        };
        this.connectionStates.set(userId, newState);

        // Log health status
        logger.info('[Matrix Service] Health check completed:', {
          userId,
          health,
          timeSinceLastActivity,
          syncState: client?.getSyncState()
        });

        // Attempt recovery if unhealthy
        if (health === CONNECTION_HEALTH.UNHEALTHY) {
          await this.attemptRecovery(userId, client);
        }
      } catch (error) {
        await this.handleError(userId, error, {
          method: 'healthCheck',
          lastState: this.getConnectionState(userId)
        });
      }
    }, this.HEALTH_CHECK_INTERVAL);

    this.healthCheckIntervals.set(userId, interval);
  }

  attemptRecovery = async (userId, client) => {
    const attempts = this.reconnectAttempts.get(userId) || 0;
    
    try {
      if (attempts >= this.MAX_RECONNECT_ATTEMPTS) {
        const error = new Error('Max reconnection attempts reached');
        await this.handleError(userId, error, {
          attempts,
          method: 'attemptRecovery'
        });
        this.updateConnectionState(userId, CONNECTION_STATES.ERROR, error);
        return false;
      }

      this.updateConnectionState(userId, CONNECTION_STATES.RECONNECTING);
      this.reconnectAttempts.set(userId, attempts + 1);

      // Log recovery attempt
      logger.info('[Matrix Service] Attempting recovery:', {
        userId,
        attempt: attempts + 1,
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS
      });

      // Stop existing client
      if (client) {
        await client.stopClient();
        // Wait for client to fully stop
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Get stored credentials
      const { data: credentials } = await supabase
        .from('matrix_credentials')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!credentials) {
        throw new Error('No credentials found for recovery');
      }

      // Initialize new client
      const newClient = await this.initializeMatrixClient(credentials);
      
      // Update stored client reference
      this.matrixClients.set(userId, newClient);
      
      // Reset reconnect attempts on success
      this.reconnectAttempts.set(userId, 0);
      
      // Reset error counts for recovered error types
      this.resetErrorCount(userId, ERROR_TYPES.NETWORK);
      this.resetErrorCount(userId, ERROR_TYPES.SYNC);
      
      this.updateConnectionState(userId, CONNECTION_STATES.CONNECTED);

      // Log successful recovery
      logger.info('[Matrix Service] Recovery successful:', {
        userId,
        attempt: attempts + 1,
        newClientId: newClient.credentials.userId
      });

      return true;
    } catch (error) {
      const recovery = await this.handleError(userId, error, {
        method: 'attemptRecovery',
        attempt: attempts + 1,
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS
      });

      // If we should retry, wait with exponential backoff
      if (recovery.shouldRetry) {
        await new Promise(resolve => setTimeout(resolve, recovery.backoffMs));
        return this.attemptRecovery(userId, client);
      }

      return false;
    }
  }

  cleanup = async (userId) => {
    try {
      // Get connection data
      const connection = this.connections.get(userId);
      if (connection) {
        // Unsubscribe from token updates
        if (connection.tokenUnsubscribe) {
          connection.tokenUnsubscribe();
        }

        // Stop client and remove from memory
        const client = this.matrixClients.get(userId);
        if (client) {
          client.stopClient();
          this.matrixClients.delete(userId);
        }

        // Clear connection data
        this.connections.delete(userId);

        logger.info('[Matrix Service] Cleaned up resources for user:', {
          userId,
          hadClient: !!client,
          hadConnection: true
        });
      }
    } catch (error) {
      logger.error('[Matrix Service] Error during cleanup:', {
        userId,
        error: error.message
      });
    }
  }

  initializeClient = async (userId, credentials) => {
    try {
      // Validate credentials
      if (!credentials?.homeserver || !credentials?.accessToken || !credentials?.userId) {
        throw new Error('Invalid Matrix credentials');
      }

      // Check rate limits for token refresh
      const tokenLimit = await this.tokenLimiter.get({ id: userId });
      if (!tokenLimit.remaining) {
        const retryAfter = Math.ceil((tokenLimit.reset - Date.now()) / 1000);
        throw new Error(`Token refresh rate limit exceeded. Retry after ${retryAfter} seconds`);
      }

      // Create Matrix client
      const client = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: credentials.accessToken,
        userId: credentials.userId,
        timeoutMs: BRIDGE_TIMEOUTS.REQUEST,
        localTimeoutMs: BRIDGE_TIMEOUTS.LOCAL
      });

      // Set up event handlers
      client.on('sync', (state, prevState, data) => {
        this.handleSyncStateChange(userId, state, prevState, data);
      });

      client.on('Room.timeline', (event, room) => {
        this.handleTimelineEvent(userId, event, room);
      });

      // Start client
      await this.startClient(userId, client);

      // Store client in active connections
      this.connectionPool.active.set(userId, {
        client,
        lastUsed: Date.now(),
        syncState: SYNC_STATES.PREPARING
      });

      // Start health check for this client
      this.startHealthCheck(userId, client);

      return client;

    } catch (error) {
      await this.handleError(userId, error, { operation: 'initializeClient' });
      throw error;
    }
  }

  startClient = async (userId, client) => {
    try {
      // Set connection state
      this.connectionStates.set(userId, CONNECTION_STATES.INITIALIZING);

      // Start sync with retry logic
      let syncAttempts = 0;
      const maxSyncAttempts = 3;

      while (syncAttempts < maxSyncAttempts) {
        try {
          // Check sync rate limits
          const syncLimit = await this.syncLimiter.get({ id: userId });
          if (!syncLimit.remaining) {
            const retryAfter = Math.ceil((syncLimit.reset - Date.now()) / 1000);
            throw new Error(`Sync rate limit exceeded. Retry after ${retryAfter} seconds`);
          }

          // Start client sync
          await client.startClient({
            initialSyncLimit: SYNC_BATCH_SIZE,
            includeArchivedRooms: false,
            lazyLoadMembers: true
          });

          // Wait for initial sync
          await this.waitForSync(userId, client);

          // Update connection state
          this.connectionStates.set(userId, CONNECTION_STATES.CONNECTED);
          return true;

        } catch (error) {
          syncAttempts++;
          if (syncAttempts === maxSyncAttempts) {
            throw error;
          }
          await sleep(this.RECONNECT_DELAY * Math.pow(2, syncAttempts));
        }
      }

    } catch (error) {
      this.connectionStates.set(userId, CONNECTION_STATES.ERROR);
      await this.handleError(userId, error, { operation: 'startClient' });
      throw error;
    }
  }

  async waitForSync(matrixClient) {
    if (!matrixClient) {
      throw new Error('Matrix client is required for sync');
    }

    return new Promise((resolve, reject) => {
      logger.debug('[Matrix Service] Starting waitForSync', {
        clientId: matrixClient.getUserId()
      });
      
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Matrix sync timeout after 30s'));
      }, this.SYNC_TIMEOUT);

      const cleanup = () => {
        logger.debug('[Matrix Service] Cleaning up sync listeners');
        matrixClient.removeListener('sync', onSync);
        clearTimeout(timeout);
      };

      const onSync = (state) => {
        logger.debug('[Matrix Service] Matrix sync state:', {
          state,
          clientId: matrixClient.getUserId()
        });

        switch (state) {
          case 'PREPARED':
          case 'SYNCING':
            cleanup();
            resolve();
            break;

          case 'ERROR':
            cleanup();
            reject(new Error(`Matrix sync failed: state=${state}`));
            break;

          case 'RECONNECTING':
            logger.info('[Matrix Service] Matrix client reconnecting');
            break;

          default:
            logger.debug('[Matrix Service] Unhandled sync state:', { state });
        }
      };

      matrixClient.on('sync', onSync);

      // Check if already synced
      if (matrixClient.isInitialSyncComplete()) {
        logger.debug('[Matrix Service] Matrix client already synced');
        cleanup();
        resolve();
      }
    });
  }

  handleSyncStateChange = (userId, state, prevState, data) => {
    try {
      // Update sync state
      this.syncStates.set(userId, state);

      // Log state change
      logger.info('[Matrix Service] Sync state changed:', {
        userId,
        from: prevState,
        to: state,
        data
      });

      // Handle different states
      switch (state) {
        case 'PREPARED':
        case 'SYNCING':
          // Reset error counts on successful sync
          this.errorCounts.delete(userId);
          break;

        case 'ERROR':
          // Handle sync error
          this.handleError(userId, new Error('Sync error'), {
            operation: 'sync',
            prevState,
            data
          });
          break;

        case 'RECONNECTING':
          // Update connection state
          this.connectionStates.set(userId, CONNECTION_STATES.INITIALIZING);
          break;
      }

      // Emit sync state change
      const io = getIO();
      if (io) {
        io.to(userId).emit('matrix:sync_state', {
          userId,
          state,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      logger.error('[Matrix Service] Error handling sync state change:', error);
    }
  }

  startHealthCheck = async (userId, client) => {
    // Clear any existing health check
    if (this.healthCheckIntervals.has(userId)) {
      clearInterval(this.healthCheckIntervals.get(userId));
    }

    // Start new health check interval
    const interval = setInterval(async () => {
      try {
        const health = await this.checkClientHealth(userId, client);
        
        // Log health status
        logger.info('[Matrix Service] Client health check:', {
          userId,
          health
        });

        // Handle unhealthy state
        if (health.status === CONNECTION_HEALTH.UNHEALTHY) {
          await this.handleUnhealthyClient(userId, client, health);
        }

      } catch (error) {
        logger.error('[Matrix Service] Health check failed:', {
          userId,
          error
        });
      }
    }, this.HEALTH_CHECK_INTERVAL);

    this.healthCheckIntervals.set(userId, interval);
  }

  checkClientHealth = async (userId, client) => {
    const health = {
      status: CONNECTION_HEALTH.HEALTHY,
      syncState: this.syncStates.get(userId),
      connectionState: this.connectionStates.get(userId),
      errorCount: this.errorCounts.get(userId),
      lastError: this.lastErrors.get(userId),
      timestamp: Date.now()
    };

    // Check sync state
    if (health.syncState === 'ERROR' || health.syncState === 'RECONNECTING') {
      health.status = CONNECTION_HEALTH.DEGRADED;
    }

    // Check error counts
    const errors = health.errorCount || {};
    if (errors[ERROR_TYPES.AUTH] > this.errorThresholds.AUTH ||
        errors[ERROR_TYPES.SYNC] > this.errorThresholds.SYNC) {
      health.status = CONNECTION_HEALTH.UNHEALTHY;
    }

    // Check connection state
    if (health.connectionState === CONNECTION_STATES.ERROR) {
      health.status = CONNECTION_HEALTH.UNHEALTHY;
    }

    return health;
  }

  handleUnhealthyClient = async (userId, client, health) => {
    try {
      logger.warn('[Matrix Service] Unhealthy client detected:', {
        userId,
        health
      });

      // Increment reconnect attempts
      const attempts = (this.reconnectAttempts.get(userId) || 0) + 1;
      this.reconnectAttempts.set(userId, attempts);

      if (attempts > this.MAX_RECONNECT_ATTEMPTS) {
        logger.error('[Matrix Service] Max reconnect attempts reached:', {
          userId,
          attempts
        });
        
        // Move to idle pool
        await this.moveToIdlePool(userId);
        return;
      }

      // Attempt recovery
      await this.attemptRecovery(userId, client);

    } catch (error) {
      logger.error('[Matrix Service] Error handling unhealthy client:', {
        userId,
        error
      });
    }
  }

  attemptRecovery = async (userId, client) => {
    try {
      logger.info('[Matrix Service] Attempting client recovery:', { userId });

      // Stop client
      client.stopClient();

      // Clear existing state
      this.syncStates.delete(userId);
      this.connectionStates.set(userId, CONNECTION_STATES.INITIALIZING);

      // Attempt to restart client
      await this.startClient(userId, client);

      // Reset reconnect attempts on success
      this.reconnectAttempts.delete(userId);

      logger.info('[Matrix Service] Client recovery successful:', { userId });

    } catch (error) {
      logger.error('[Matrix Service] Recovery attempt failed:', {
        userId,
        error
      });
      throw error;
    }
  }

  async handleError(userId, error, context = {}) {
    const errorType = this.classifyError(error);
    const errorCount = this.incrementErrorCount(userId, errorType);
    const threshold = this.errorTracking.thresholds[errorType] || 5;

    // Log error with context
    logger.error('[Matrix Service] Error occurred:', {
      userId,
      type: errorType,
      count: errorCount,
      context,
      error: error.message,
      stack: error.stack
    });

    // Check if we should retry based on error type and count
    const shouldRetry = await this.determineRetryStrategy(userId, errorType, errorCount, threshold);

    if (shouldRetry) {
      await this.executeRetryStrategy(userId, errorType, context);
    } else {
      await this.handleFailedRetries(userId, errorType, context);
    }

    return {
      shouldRetry,
      errorType,
      errorCount,
      threshold
    };
  }

  classifyError(error) {
    const message = error.message?.toLowerCase() || '';
    const code = error.code?.toLowerCase() || '';

    if (message.includes('rate') || code.includes('m_limit_exceeded')) {
      return 'RATE_LIMIT';
    }
    if (message.includes('auth') || message.includes('token') || code.includes('m_unknown_token')) {
      return 'AUTH';
    }
    if (message.includes('network') || message.includes('timeout') || code.includes('m_unknown')) {
      return 'NETWORK';
    }
    if (message.includes('sync') || code.includes('m_bad_sync')) {
      return 'SYNC';
    }
    return 'UNKNOWN';
  }

  incrementErrorCount(userId, errorType) {
    const key = `${userId}:${errorType}`;
    const currentCount = this.errorTracking.counts.get(key) || 0;
    this.errorTracking.counts.set(key, currentCount + 1);
    return currentCount + 1;
  }

  async determineRetryStrategy(userId, errorType, errorCount, threshold) {
    // Don't retry if we've exceeded the threshold
    if (errorCount >= threshold) {
      return false;
    }

    switch (errorType) {
      case 'RATE_LIMIT':
        // Implement exponential backoff for rate limits
        await this.syncLimiter.removeTokens(1);
        return true;

      case 'AUTH':
        // Try to refresh token before giving up
        const refreshed = await this.refreshUserToken(userId);
        return refreshed;

      case 'NETWORK':
        // Retry with increasing delays for network issues
        await this.delay(Math.min(1000 * Math.pow(2, errorCount), 30000));
        return true;

      case 'SYNC':
        // Clear sync state and retry
        this.syncStates.delete(userId);
        return errorCount < 3;

      default:
        return errorCount < 2;
    }
  }

  async executeRetryStrategy(userId, errorType, context) {
    switch (errorType) {
      case 'RATE_LIMIT':
        await this.handleRateLimitRetry(userId);
        break;
      case 'AUTH':
        await this.handleAuthRetry(userId);
        break;
      case 'NETWORK':
        await this.handleNetworkRetry(userId);
        break;
      case 'SYNC':
        await this.handleSyncRetry(userId);
        break;
      default:
        await this.handleDefaultRetry(userId);
    }

    // Log retry attempt
    logger.info('[Matrix Service] Executing retry strategy:', {
      userId,
      errorType,
      context
    });
  }

  async handleFailedRetries(userId, errorType, context) {
    // Log failure
    logger.error('[Matrix Service] Retry attempts exhausted:', {
      userId,
      errorType,
      context
    });

    // Cleanup resources
    await this.closeConnection(userId, this.connections.get(userId));
    
    // Notify monitoring system
    await this.notifyMonitoring({
      type: 'RETRY_EXHAUSTED',
      userId,
      errorType,
      context
    });

    // Clear error counts after handling
    this.resetErrorCountsForUser(userId);
  }

  async refreshUserToken(userId) {
    try {
      const newTokens = await tokenService.refreshToken(userId);
      if (newTokens?.access_token) {
        // Update client with new token
        const client = this.matrixClients.get(userId);
        if (client) {
          client.setAccessToken(newTokens.access_token);
        }
        return true;
      }
    } catch (error) {
      logger.error('[Matrix Service] Token refresh failed:', {
        userId,
        error: error.message
      });
    }
    return false;
  }

  resetErrorCountsForUser(userId) {
    for (const [key, _] of this.errorTracking.counts) {
      if (key.startsWith(`${userId}:`)) {
        this.errorTracking.counts.delete(key);
      }
    }
  }

  resetErrorCounts() {
    this.errorTracking.counts.clear();
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async notifyMonitoring(data) {
    try {
      // Implement monitoring notification
      // This could be sending metrics to a monitoring service
      // or triggering alerts based on error patterns
      await monitoringService.notify(data);
    } catch (error) {
      logger.error('[Matrix Service] Failed to notify monitoring:', {
        error: error.message,
        data
      });
    }
  }

  // Helper methods for sync token management
  storeSyncToken = async (userId, token) => {
    const key = `sync_token:${userId}`;
    await pubClient.set(key, token, 'EX', 86400); // Store for 24 hours
  };

  getSavedSyncToken = async (userId) => {
    const key = `sync_token:${userId}`;
    return await pubClient.get(key);
  };

  async fetchContactsFromMatrix(userId) {
    try {
      // Get Matrix client for the user
      const matrixClient = await this.getMatrixClientWithRetry(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not available');
      }

      // Get all WhatsApp rooms
      const rooms = await this.getWhatsAppRooms(matrixClient);
      
      // Process each room to extract contact information
      const contacts = await Promise.all(rooms.map(async room => {
        try {
          // Skip if not a WhatsApp room
          if (!room.name?.includes('(WA)') && !room.name?.includes('WhatsApp')) {
            return null;
          }

          // Get room members
          const members = room.getJoinedMembers();
          const bridgeBot = members.find(m => m.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot);
          
          // Skip if bridge bot is not in the room
          if (!bridgeBot) {
            return null;
          }

          // Get WhatsApp ID from room state or name
          let whatsappId = null;
          const stateEvents = room.currentState.getStateEvents('m.room.whatsapp');
          if (stateEvents && stateEvents[0]) {
            whatsappId = stateEvents[0].getContent().whatsapp_id;
          }

          if (!whatsappId) {
            const phoneMatch = room.name.match(/([0-9]+)/);
            whatsappId = phoneMatch ? phoneMatch[0] : null;
          }

          if (!whatsappId) {
            return null;
          }

          // Get last message if available
          let lastMessage = null;
          let lastMessageTime = null;
          const timeline = room.timeline;
          if (timeline && timeline.length > 0) {
            const lastEvent = timeline[timeline.length - 1];
            if (lastEvent.getType() === 'm.room.message') {
              lastMessage = lastEvent.getContent().body;
              lastMessageTime = new Date(lastEvent.getTs()).toISOString();
            }
          }

          // Get unread count
          const readUpToEventId = room.getEventReadUpTo(matrixClient.getUserId());
          const unreadCount = timeline ? 
            timeline.filter(event => 
              event.getType() === 'm.room.message' && 
              event.getId() > readUpToEventId
            ).length : 0;

          // Build contact object
          return {
            user_id: userId,
            whatsapp_id: whatsappId,
            display_name: room.name.replace(' (WA)', '').trim(),
            sync_status: 'active',
            metadata: {
              room_id: room.roomId,
              room_name: room.name,
              last_message: lastMessage,
              last_message_at: lastMessageTime,
              unread_count: unreadCount
            }
          };
        } catch (error) {
          console.error('Error processing room:', room.roomId, error);
          return null;
        }
      }));

      // Filter out null values and return valid contacts
      return contacts.filter(Boolean);

    } catch (error) {
      console.error('Failed to fetch contacts from Matrix:', error);
      throw error;
    }
  }

  async getWhatsAppRooms(matrixClient) {
    try {
      if (!matrixClient) {
        throw new Error('Matrix client not provided');
      }

      // Get all rooms the user is in
      const rooms = matrixClient.getRooms();
      
      // Filter for WhatsApp rooms
      const whatsappRooms = rooms.filter(room => {
        // Check if room has bridge bot
        const members = room.getJoinedMembers();
        const hasBridgeBot = members.some(member => 
          member.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot
        );

        // Check if room name indicates WhatsApp
        const isWhatsAppRoom = room.name && (
          room.name.includes('(WA)') || 
          room.name.includes('WhatsApp')
        );

        // Check for WhatsApp state events
        const hasWhatsAppState = room.currentState.getStateEvents('m.room.whatsapp').length > 0;

        return hasBridgeBot && (isWhatsAppRoom || hasWhatsAppState);
      });

      return whatsappRooms;
    } catch (error) {
      console.error('Error getting WhatsApp rooms:', error);
      throw error;
    }
  }

  async emitSocketEvent(userId, event, data) {
    try {
      const io = getIO();
      if (!io) {
        logger.warn('[Matrix Service] Socket.IO not initialized');
        return;
      }

      const socket = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (socket) {
        // Socket is connected, emit immediately
        io.to(`user:${userId}`).emit(event, data);
      } else {
        // Store for offline delivery
        const offlineKey = `offline:${userId}:${event}`;
        await pubClient.set(offlineKey, JSON.stringify({
          event,
          data,
          timestamp: Date.now()
        }), 'EX', 86400); // Store for 24 hours
      }
    } catch (error) {
      logger.error('[Matrix Service] Error emitting socket event:', {
        userId,
        event,
        error: error.message
      });
    }
  }

  async deliverOfflineEvents(userId) {
    try {
      const pattern = `offline:${userId}:*`;
      const keys = await pubClient.keys(pattern);
      
      if (keys.length === 0) return;

      const io = getIO();
      if (!io) {
        logger.warn('[Matrix Service] Socket.IO not initialized for offline delivery');
        return;
      }

      for (const key of keys) {
        const data = await pubClient.get(key);
        if (data) {
          const { event, data: eventData } = JSON.parse(data);
          io.to(`user:${userId}`).emit(event, eventData);
          await pubClient.del(key);
        }
      }
    } catch (error) {
      logger.error('[Matrix Service] Error delivering offline events:', {
        userId,
        error: error.message
      });
    }
  }
}

// Create service instance
const matrixWhatsAppService = new MatrixWhatsAppService();

// Add cleanup on process exit
process.on('SIGTERM', async () => {
  logger.info('[Matrix Service] Starting cleanup on SIGTERM');
  const cleanupPromises = Array.from(matrixWhatsAppService.connections.keys()).map(userId => 
    matrixWhatsAppService.cleanup(userId)
  );
  await Promise.allSettled(cleanupPromises);
  logger.info('[Matrix Service] Cleanup complete');
});

export { matrixWhatsAppService }; 