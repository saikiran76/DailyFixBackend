import Redis from 'ioredis';
import logger from '../utils/logger.js';

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  showFriendlyErrorStack: true,
  lazyConnect: false
};

class RedisService {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;
    this.isConnected = false;
    this.connectionPromise = null;
  }

  async connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise(async (resolve, reject) => {
    try {
        logger.info('Redis service initialized with config:', { ...REDIS_CONFIG, password: '[REDACTED]', service: 'dailyfix-backend' });
        
        logger.info('Creating new Redis connection', { service: 'dailyfix-backend' });
        
      // Create main client
      this.client = new Redis(REDIS_CONFIG);
      
        // Create pub client
      this.pubClient = new Redis(REDIS_CONFIG);
        
        // Create sub client
      this.subClient = new Redis(REDIS_CONFIG);

        // Set up event handlers for main client
      this.client.on('connect', () => {
          logger.info('Redis Client Connected', { service: 'dailyfix-backend' });
        });

        this.client.on('ready', () => {
          logger.info('Redis Client Ready', { service: 'dailyfix-backend' });
          this.isConnected = true;
          resolve();
        });

        this.client.on('error', (error) => {
          logger.error('Redis Client Error:', { error: error.message, service: 'dailyfix-backend' });
          if (!this.isConnected) {
            reject(error);
          }
        });

      } catch (error) {
        logger.error('Failed to initialize Redis:', { error: error.message, service: 'dailyfix-backend' });
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  async disconnect() {
    logger.info('Disconnecting Redis client', { service: 'dailyfix-backend' });
    
    if (this.client) {
      await this.client.quit();
    }
    if (this.pubClient) {
      await this.pubClient.quit();
    }
    if (this.subClient) {
      await this.subClient.quit();
    }
    
    this.isConnected = false;
    this.connectionPromise = null;
    logger.info('Redis client disconnected', { service: 'dailyfix-backend' });
  }

  getClient() {
    return this.client;
  }

  getPubClient() {
    return this.pubClient;
  }

  getSubClient() {
    return this.subClient;
  }

  getConnectionStatus() {
    return this.isConnected;
  }

  async ping() {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis ping failed:', { error: error.message, service: 'dailyfix-backend' });
      return false;
    }
  }
}

export const redisService = new RedisService(); 