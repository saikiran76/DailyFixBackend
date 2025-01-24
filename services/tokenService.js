import { supabase } from '../utils/supabase.js';
import { logger } from '../utils/logger.js';
import { adminClient } from '../utils/supabase.js';
import { matrixService } from './matrixService.js';
import { redisClient } from '../utils/redis.js';

class TokenService {
  constructor() {
    this.initialized = false;
    this.subscribers = new Set();
    this.activeSession = null;
    this.refreshTimer = null;
    this.tokenRefreshPromise = null;
    this.lastRefresh = null;
    this.MIN_TOKEN_LIFETIME = 30000; // 30 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup every minute
    this.sessionCache = new Map();
  }

  async initialize() {
    try {
      logger.info('[Token] Initializing token service...');

      // Try to get stored session
      const session = await this.getStoredSession();
      
      if (!session) {
        logger.warn('[Token] No active session found - initializing in stateless mode');
        this.initialized = true;
        return true;
      }

      // Initialize with existing session
      this.activeSession = session;
      
      // Setup refresh timer if we have a session
      if (session.expires_at) {
        this.setupRefreshTimer(session.expires_at);
      }

      this.initialized = true;
      logger.info('[Token] Token service initialized successfully');
      
      return true;
    } catch (error) {
      logger.warn('[Token] Initializing without active session:', error);
      this.initialized = true;
      return true;
    }
  }

  async getStoredSession() {
    try {
      const { data: session } = await adminClient.auth.getSession();
      return session;
    } catch (error) {
      logger.debug('[Token] No stored session found:', error);
      return null;
    }
  }

  setupRefreshTimer(expiresAt) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const now = Date.now();
    const expiryTime = new Date(expiresAt).getTime();
    const timeToExpiry = expiryTime - now;
    
    // Refresh 5 minutes before expiry
    const refreshTime = Math.max(timeToExpiry - 300000, 0);
    
    if (refreshTime > 0) {
      this.refreshTimer = setTimeout(() => this.refreshToken(), refreshTime);
      logger.debug('[Token] Refresh timer set for:', new Date(now + refreshTime));
    }
  }

  async getValidToken() {
    try {
      // Check if we're already refreshing
      if (this.tokenRefreshPromise) {
        return this.tokenRefreshPromise;
      }

      // Check cache first
      const cachedSession = await this._getSessionFromCache();
      if (cachedSession) {
        return cachedSession;
      }

      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError) {
        logger.warn('Session error:', sessionError);
        return null;
      }

      if (!session) {
        logger.warn('No active session found');
        return null;
      }

      // Validate token structure and expiry
      if (!await this.validateToken(session.access_token)) {
        logger.warn('Invalid token structure or expired');
        return null;
      }

      // Check if token needs refresh
      if (this.shouldRefreshToken(session)) {
        return this.refreshToken();
      }

      const tokenData = {
        access_token: session.access_token,
        userId: session.user.id,
        expires_at: session.expires_at
      };

      // Cache the valid session
      await this._cacheSession(tokenData);

      return tokenData;
    } catch (error) {
      logger.error('Failed to get valid token:', error);
      return null;
    }
  }

  async _getSessionFromCache() {
    try {
      const cachedData = await redisClient.get('session:token');
      if (!cachedData) return null;

      const session = JSON.parse(cachedData);
      if (!session || Date.now() >= session.expires_at * 1000) {
        return null;
      }

      return session;
    } catch (error) {
      logger.error('Error reading session from cache:', error);
      return null;
    }
  }

  async _cacheSession(tokenData) {
    try {
      await redisClient.set(
        'session:token',
        JSON.stringify(tokenData),
        'EX',
        Math.floor((tokenData.expires_at * 1000 - Date.now()) / 1000)
      );
    } catch (error) {
      logger.error('Error caching session:', error);
    }
  }

  async validateToken(token, type = 'dailyfix') {
    if (!token) return false;
    
    try {
      // Basic JWT format validation
      const parts = token.split('.');
      if (parts.length !== 3) return false;

      // Validate header and payload are valid JSON
      const header = JSON.parse(atob(parts[0]));
      const payload = JSON.parse(atob(parts[1]));

      // Check required fields
      if (!header.alg || !payload.exp) return false;

      // Check expiration
      const expiresAt = payload.exp * 1000;
      if (Date.now() >= expiresAt) return false;

      // For Matrix tokens, verify with homeserver
      if (type === 'matrix') {
        try {
          const client = await matrixService.getClient(payload.sub);
          if (!client) return false;
          
          // Verify token with whoami
          await client.whoami();
          return true;
        } catch (error) {
          logger.error('Matrix token validation failed:', error);
          return false;
        }
      }

      // For DailyFix tokens, verify with Supabase
      if (type === 'dailyfix') {
        const { data: { user }, error } = await adminClient.auth.getUser(token);
        if (error || !user) {
          logger.error('DailyFix token validation failed:', error);
          return false;
        }
        return true;
      }

      return true;
    } catch (error) {
      logger.error('Token validation failed:', error);
      return false;
    }
  }

  shouldRefreshToken(session) {
    if (!session?.expires_at) return true;
    
    const expiresAt = session.expires_at * 1000; // Convert to milliseconds
    const now = Date.now();
    
    return (expiresAt - now) < this.MIN_TOKEN_LIFETIME;
  }

  async refreshToken() {
    try {
      // Ensure only one refresh at a time
      if (this.tokenRefreshPromise) {
        return this.tokenRefreshPromise;
      }

      this.tokenRefreshPromise = (async () => {
        try {
          const { data, error } = await supabase.auth.refreshSession();
          
          if (error) {
            logger.warn('Token refresh failed:', error);
            return null;
          }

          if (!data.session) {
            logger.warn('No session after refresh');
            return null;
          }

          // Validate refreshed token
          if (!this.validateToken(data.session.access_token)) {
            logger.warn('Invalid token structure after refresh');
            return null;
          }

          this.lastRefresh = Date.now();
          
          const tokenData = {
            access_token: data.session.access_token,
            userId: data.session.user.id,
            expires_at: data.session.expires_at
          };

          // Notify subscribers of new token
          this._notifySubscribers(tokenData);
          
          // Cache the refreshed session
          await this._cacheSession(tokenData);
          
          return tokenData;
        } finally {
          this.tokenRefreshPromise = null;
        }
      })();

      return this.tokenRefreshPromise;
    } catch (error) {
      logger.error('Token refresh failed:', error);
      return null;
    }
  }

  subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Subscriber callback must be a function');
    }
    
    this.subscribers.add(callback);
    
    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  _notifySubscribers(tokenData) {
    this.subscribers.forEach(callback => {
      try {
        callback(tokenData);
      } catch (error) {
        logger.error('Error in token subscriber:', error);
      }
    });
  }

  cleanup() {
    // Clear any stale refresh promise
    if (this.tokenRefreshPromise && Date.now() - this.lastRefresh > 60000) {
      this.tokenRefreshPromise = null;
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.subscribers.clear();
    this.tokenRefreshPromise = null;
  }
}

export const tokenService = new TokenService();
export default tokenService; 