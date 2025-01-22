import Redis from 'ioredis';
import { logger } from './logger.js';

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
};

class RedisService {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;
    this.isReady = false;
    this.initPromise = this.connect();
  }

  async connect() {
    try {
      // Create main client
      this.client = new Redis(REDIS_CONFIG);
      
      // Create separate clients for pub/sub
      this.pubClient = new Redis(REDIS_CONFIG);
      this.subClient = new Redis(REDIS_CONFIG);

      // Set up event handlers
      this.client.on('connect', () => {
        logger.info('Redis Client Connected');
        this.isReady = true;
      });

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        this.isReady = false;
      });

      this.pubClient.on('connect', () => {
        logger.info('Redis Pub Client Connected');
      });

      this.subClient.on('connect', () => {
        logger.info('Redis Sub Client Connected');
      });

      // Wait for initial connection
      await Promise.all([
        new Promise(resolve => this.client.once('ready', resolve)),
        new Promise(resolve => this.pubClient.once('ready', resolve)),
        new Promise(resolve => this.subClient.once('ready', resolve))
      ]);

      logger.info('Redis clients connected successfully');
    } catch (error) {
      logger.error('Failed to connect Redis clients:', error);
      throw error;
    }
  }

  async ensureConnection() {
    await this.initPromise;
    if (!this.isReady) {
      throw new Error('Redis client not ready');
    }
  }

  async ping() {
    await this.ensureConnection();
    return this.client.ping();
  }

  async get(key) {
    await this.ensureConnection();
    return this.client.get(key);
  }

  async set(key, value, expiry = null) {
    await this.ensureConnection();
    if (expiry) {
      return this.client.set(key, value, 'EX', expiry);
    }
    return this.client.set(key, value);
  }

  async del(key) {
    await this.ensureConnection();
    return this.client.del(key);
  }

  async publish(channel, message) {
    await this.ensureConnection();
    return this.pubClient.publish(channel, JSON.stringify(message));
  }

  subscribe(channel, callback) {
    this.subClient.subscribe(channel);
    this.subClient.on('message', (ch, message) => {
      if (ch === channel) {
        try {
          callback(JSON.parse(message));
        } catch (error) {
          logger.error('Error processing Redis message:', error);
        }
      }
    });
  }

  async disconnect() {
    try {
      await Promise.all([
        this.client?.disconnect(),
        this.pubClient?.disconnect(),
        this.subClient?.disconnect()
      ]);
      this.isReady = false;
      logger.info('Redis clients disconnected');
    } catch (error) {
      logger.error('Error disconnecting Redis clients:', error);
      throw error;
    }
  }
}

export const redisClient = new RedisService();
export default redisClient; 