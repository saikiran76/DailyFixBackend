import Redis from 'ioredis';
import logger from '../services/logger.js';

const LOCK_CONFIG = {
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  LOCK_TTL: 30000,
  DRIFT_FACTOR: 0.01,
  RETRY_JITTER: 100
};

class DistributedLock {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  async acquire(key, ttl = LOCK_CONFIG.LOCK_TTL) {
    const lockKey = `lock:${key}`;
    const lockValue = Date.now().toString();
    let retries = 0;

    while (retries < LOCK_CONFIG.RETRY_COUNT) {
      try {
        // Try to set the lock with NX (only if it doesn't exist)
        const acquired = await this.redis.set(lockKey, lockValue, 'PX', ttl, 'NX');
        
        if (acquired) {
          logger.debug(`Lock acquired for ${key}`);
          return lockValue;
        }

        // Add jitter to retry delay
        const jitter = Math.random() * LOCK_CONFIG.RETRY_JITTER;
        const delay = LOCK_CONFIG.RETRY_DELAY * Math.pow(2, retries) + jitter;
        await new Promise(resolve => setTimeout(resolve, delay));
        
        retries++;
      } catch (error) {
        logger.error(`Error acquiring lock for ${key}:`, error);
        throw error;
      }
    }

    logger.warn(`Failed to acquire lock for ${key} after ${LOCK_CONFIG.RETRY_COUNT} attempts`);
    return null;
  }

  async release(key, lockValue) {
    const lockKey = `lock:${key}`;
    
    try {
      // Only release if we own the lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      
      const result = await this.redis.eval(script, 1, lockKey, lockValue);
      if (result === 1) {
        logger.debug(`Lock released for ${key}`);
        return true;
      }
      
      logger.warn(`Lock for ${key} was already released or owned by another process`);
      return false;
    } catch (error) {
      logger.error(`Error releasing lock for ${key}:`, error);
      throw error;
    }
  }

  async extend(key, lockValue, ttl = LOCK_CONFIG.LOCK_TTL) {
    const lockKey = `lock:${key}`;
    
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      
      const result = await this.redis.eval(script, 1, lockKey, lockValue, ttl);
      if (result === 1) {
        logger.debug(`Lock extended for ${key}`);
        return true;
      }
      
      logger.warn(`Could not extend lock for ${key}: lock not owned`);
      return false;
    } catch (error) {
      logger.error(`Error extending lock for ${key}:`, error);
      throw error;
    }
  }

  async isLocked(key) {
    const lockKey = `lock:${key}`;
    try {
      const exists = await this.redis.exists(lockKey);
      return exists === 1;
    } catch (error) {
      logger.error(`Error checking lock status for ${key}:`, error);
      throw error;
    }
  }

  async withLock(key, operation, ttl = LOCK_CONFIG.LOCK_TTL) {
    const lockValue = await this.acquire(key, ttl);
    if (!lockValue) {
      throw new Error(`Could not acquire lock for ${key}`);
    }

    try {
      const result = await operation();
      return result;
    } finally {
      try {
        await this.release(key, lockValue);
      } catch (error) {
        logger.error(`Error releasing lock for ${key}:`, error);
      }
    }
  }
}

export { DistributedLock, LOCK_CONFIG }; 