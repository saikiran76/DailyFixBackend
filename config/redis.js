import dotenv from 'dotenv';
import { createClient } from 'redis';
import logger from '../services/logger.js';
dotenv.config();

const isDevelopment = process.env.NODE_ENV !== 'production';

// Base Redis configuration
const baseConfig = {
  retryStrategy: (times) => {
    const delay = Math.min(times * 1000, 3000);
    logger.info(`Redis retry attempt ${times} with delay ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  noDelay: true,
  commandTimeout: 5000,
  connectTimeout: 10000,
  keepAlive: 30000,
  reconnectOnError: (err) => {
    logger.error('Redis reconnect error:', err);
    return err.message.includes('READONLY');
  }
};

// Development (local) configuration
const developmentConfig = {
  ...baseConfig,
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379', // Use IPv4 for local development
  socket: {
    reconnectStrategy: baseConfig.retryStrategy
  }
};

// Production (cloud) configuration
const productionConfig = {
  ...baseConfig,
  url: `rediss://${process.env.REDIS_USERNAME}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  socket: {
    tls: process.env.REDIS_TLS === 'true',
    rejectUnauthorized: process.env.NODE_ENV === 'production',
    reconnectStrategy: baseConfig.retryStrategy
  },
  connectionName: `dailyfix_socket_${process.env.NODE_ENV || 'production'}`
};

// Export the appropriate configuration based on environment
export const redisConfig = isDevelopment ? developmentConfig : productionConfig;

// Health check configuration
export const healthCheck = {
  isConnected: false,
  lastCheck: Date.now(),
  errors: [],
  maxErrors: 100,
  addError(error) {
    this.errors.push({
      timestamp: Date.now(),
      message: error.message,
      stack: error.stack
    });
    if (this.errors.length > this.maxErrors) {
      this.errors.shift();
    }
  },
  getStatus() {
    return {
      isConnected: this.isConnected,
      lastCheck: this.lastCheck,
      environment: isDevelopment ? 'development' : 'production',
      recentErrors: this.errors.slice(-5),
      config: isDevelopment ? 'development' : 'production'
    };
  },
  reset() {
    this.errors = [];
    this.lastCheck = Date.now();
    this.isConnected = false;
  }
};

// Socket.IO configuration
export const socketConfig = {
  HEARTBEAT: {
    INTERVAL: 30000,
    TIMEOUT: 5000,
    MAX_MISSED: 3,
  },
  RECONNECTION: {
    MAX_ATTEMPTS: 3,
    BASE_DELAY: 2000,
    MAX_DELAY: 10000,
  },
  ERROR_TYPES: {
    AUTH_FAILED: 'auth_failed',
    TIMEOUT: 'timeout',
    NETWORK: 'network_error',
    REDIS_ERROR: 'redis_error',
  },
};

// Redis Service Class
class RedisService {
  constructor() {
    this.client = null;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    try {
      this.client = createClient(redisConfig);

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        healthCheck.addError(err);
        healthCheck.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis Client Connected');
        healthCheck.isConnected = true;
        healthCheck.lastCheck = Date.now();
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis Client Reconnecting...');
      });

      this.isInitialized = true;
    } catch (error) {
      logger.error('Redis initialization error:', error);
      healthCheck.addError(error);
      throw error;
    }
  }

  async connect() {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      if (!this.client.isOpen) {
        await this.client.connect();
      }
      return this.client;
    } catch (error) {
      logger.error('Redis connection error:', error);
      healthCheck.addError(error);
      throw error;
    }
  }

  async disconnect() {
    try {
      if (this.client?.isOpen) {
        await this.client.quit();
      }
    } catch (error) {
      logger.error('Redis disconnect error:', error);
      throw error;
    }
  }

  getClient() {
    if (!this.isInitialized || !this.client) {
      throw new Error('Redis client not initialized. Call initialize() first.');
    }
    return this.client;
  }

  async isReady() {
    try {
      if (!this.client?.isOpen) {
        return false;
      }
      await this.client.ping();
      return true;
    } catch (error) {
      return false;
    }
  }
}

export const redisService = new RedisService();
