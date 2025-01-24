import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3
};

class RedisService {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;
    this._isConnected = false;
    this.connectionPromise = null;
    this.subscribers = new Map();
  }

  getConnectionStatus() {
    return this._isConnected;
  }

  async connect() {
    if (this._isConnected) {
      logger.info('Redis already connected');
      return true;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        // Create new clients only if they don't exist
        if (!this.client) this.client = new Redis(REDIS_CONFIG);
        if (!this.pubClient) this.pubClient = new Redis(REDIS_CONFIG);
        if (!this.subClient) this.subClient = new Redis(REDIS_CONFIG);

        let connectedClients = 0;
        const totalClients = 3;

        const setupClient = (client, role) => {
          client.on('connect', () => {
            logger.info(`Redis ${role} Client Connected`);
            connectedClients++;
            if (connectedClients === totalClients) {
              this._isConnected = true;
              logger.info('All Redis clients connected successfully');
              resolve(true);
            }
          });

          client.on('error', (error) => {
            logger.error(`Redis ${role} Client Error:`, error);
            this._isConnected = false;
          });

          client.on('close', () => {
            logger.warn(`Redis ${role} Client Closed`);
            this._isConnected = false;
            connectedClients = Math.max(0, connectedClients - 1);
          });
        };

        setupClient(this.client, 'Main');
        setupClient(this.pubClient, 'Pub');
        setupClient(this.subClient, 'Sub');

      } catch (error) {
        this._isConnected = false;
        logger.error('Redis Connection Error:', error);
        reject(error);
      }
    });

    try {
      await this.connectionPromise;
      return true;
    } catch (error) {
      this.connectionPromise = null;
      throw error;
    }
  }

  async ping() {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis Ping Error:', error);
      return false;
    }
  }

  async get(key) {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error(`Redis Get Error for key ${key}:`, error);
      throw error;
    }
  }

  async set(key, value, expiry = null) {
    try {
      if (expiry) {
        return await this.client.set(key, value, 'EX', expiry);
      }
      return await this.client.set(key, value);
    } catch (error) {
      logger.error(`Redis Set Error for key ${key}:`, error);
      throw error;
    }
  }

  async del(key) {
    try {
      return await this.client.del(key);
    } catch (error) {
      logger.error(`Redis Delete Error for key ${key}:`, error);
      throw error;
    }
  }

  async publish(channel, message) {
    try {
      return await this.pubClient.publish(channel, message);
    } catch (error) {
      logger.error(`Redis Publish Error for channel ${channel}:`, error);
      throw error;
    }
  }

  async subscribe(channel, callback) {
    try {
      if (!this.subscribers.has(channel)) {
        this.subscribers.set(channel, new Set());
      }
      this.subscribers.get(channel).add(callback);
      
      await this.subClient.subscribe(channel);
      this.subClient.on('message', (ch, message) => {
        if (ch === channel && this.subscribers.has(ch)) {
          this.subscribers.get(ch).forEach(cb => cb(message));
        }
      });
    } catch (error) {
      logger.error(`Redis Subscribe Error for channel ${channel}:`, error);
      throw error;
    }
  }

  async unsubscribe(channel, callback) {
    try {
      if (this.subscribers.has(channel)) {
        this.subscribers.get(channel).delete(callback);
        if (this.subscribers.get(channel).size === 0) {
          await this.subClient.unsubscribe(channel);
          this.subscribers.delete(channel);
        }
      }
    } catch (error) {
      logger.error(`Redis Unsubscribe Error for channel ${channel}:`, error);
      throw error;
    }
  }

  async disconnect() {
    if (!this._isConnected) {
      return;
    }

    try {
      const clients = [this.client, this.pubClient, this.subClient].filter(Boolean);
      await Promise.all(clients.map(client => client.disconnect()));
      
      this.client = null;
      this.pubClient = null;
      this.subClient = null;
      this._isConnected = false;
      this.connectionPromise = null;
      this.subscribers.clear();
      
      logger.info('Redis clients disconnected successfully');
    } catch (error) {
      logger.error('Redis Disconnect Error:', error);
      throw error;
    }
  }
}

export const redisClient = new RedisService(); 