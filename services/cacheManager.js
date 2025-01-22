import Redis from 'ioredis';
import logger from './logger.js';
import { redisConfig } from '../config/redis.js';

export const CACHE_KEYS = {
  WHATSAPP_STATUS: 'whatsapp:status:',
  CONTACTS: 'whatsapp:contacts:',
  MESSAGES: 'whatsapp:messages:',
  ACTIVE_USERS: 'whatsapp:active_users'
};

export const CACHE_TTL = {
  STATUS: 60 * 60, // 1 hour
  CONTACTS: 5 * 60, // 5 minutes
  MESSAGES: 30 * 60, // 30 minutes
  ACTIVE_USERS: 24 * 60 * 60 // 24 hours
};

class CacheManager {
  constructor() {
    this.redis = new Redis(redisConfig);
    this.backgroundJobs = new Map();
  }

  async setCache(key, data, ttl) {
    try {
      await this.redis.set(key, JSON.stringify(data), 'EX', ttl);
    } catch (error) {
      logger.error('Cache set error:', { key, error: error.message });
      throw error;
    }
  }

  async getCache(key) {
    try {
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Cache get error:', { key, error: error.message });
      return null;
    }
  }

  async refreshUserCache(userId) {
    try {
      // Refresh WhatsApp status
      const status = await this.fetchWhatsAppStatus(userId);
      await this.setCache(
        `${CACHE_KEYS.WHATSAPP_STATUS}${userId}`,
        status,
        CACHE_TTL.STATUS
      );

      // Refresh contacts if user is active
      if (status.status === 'active') {
        const contacts = await this.fetchContacts(userId);
        await this.setCache(
          `${CACHE_KEYS.CONTACTS}${userId}`,
          contacts,
          CACHE_TTL.CONTACTS
        );
      }

      logger.info('Cache refreshed for user:', { userId });
    } catch (error) {
      logger.error('Cache refresh error:', { userId, error: error.message });
    }
  }

  async startBackgroundRefresh(userId) {
    // Stop existing job if any
    this.stopBackgroundRefresh(userId);

    // Create new refresh interval
    const jobId = setInterval(() => {
      this.refreshUserCache(userId);
    }, Math.min(CACHE_TTL.CONTACTS, CACHE_TTL.STATUS) * 1000 / 2);

    this.backgroundJobs.set(userId, jobId);
    
    // Add user to active users set
    await this.redis.sadd(CACHE_KEYS.ACTIVE_USERS, userId);
    await this.redis.expire(CACHE_KEYS.ACTIVE_USERS, CACHE_TTL.ACTIVE_USERS);
  }

  stopBackgroundRefresh(userId) {
    const jobId = this.backgroundJobs.get(userId);
    if (jobId) {
      clearInterval(jobId);
      this.backgroundJobs.delete(userId);
    }
    // Remove user from active users set
    this.redis.srem(CACHE_KEYS.ACTIVE_USERS, userId);
  }

  async getActiveUsers() {
    try {
      return await this.redis.smembers(CACHE_KEYS.ACTIVE_USERS);
    } catch (error) {
      logger.error('Failed to get active users:', error);
      return [];
    }
  }

  // Helper method to fetch fresh WhatsApp status
  async fetchWhatsAppStatus(userId) {
    // Implementation will be added by matrixWhatsAppService
    return null;
  }

  // Helper method to fetch fresh contacts
  async fetchContacts(userId) {
    // Implementation will be added by whatsappEntityService
    return null;
  }

  // Cleanup method to be called on service shutdown
  async cleanup() {
    for (const userId of this.backgroundJobs.keys()) {
      this.stopBackgroundRefresh(userId);
    }
    await this.redis.quit();
  }
}

const cacheManager = new CacheManager();
export default cacheManager; 