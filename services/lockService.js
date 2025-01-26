import Redlock from 'redlock';
import { redisService } from '../utils/redis.js';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

const LOCK_DEFAULTS = {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 200,
  automaticExtensionThreshold: 500
};

const LOCK_METRICS = {
  ACQUISITION_ATTEMPT: 'lock_acquisition_attempt',
  ACQUISITION_SUCCESS: 'lock_acquisition_success',
  ACQUISITION_FAILURE: 'lock_acquisition_failure',
  RELEASE_SUCCESS: 'lock_release_success',
  RELEASE_FAILURE: 'lock_release_failure',
  EXTENSION_ATTEMPT: 'lock_extension_attempt',
  EXTENSION_SUCCESS: 'lock_extension_success',
  EXTENSION_FAILURE: 'lock_extension_failure'
};

class LockService extends EventEmitter {
  constructor() {
    super();
    this.redlock = null;
    this.activeLocks = new Map();
    this.metrics = new Map();
    this.cleanupInterval = null;
    this.initialized = false;

    // Initialize metrics
    Object.values(LOCK_METRICS).forEach(metric => {
      this.metrics.set(metric, 0);
    });
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const client = await redisService.getPubClient();
      if (!client) {
        throw new Error('Redis client not available');
      }

      this.redlock = new Redlock([client], {
        ...LOCK_DEFAULTS,
        retryCount: parseInt(process.env.LOCK_RETRY_COUNT || '3', 10),
        retryDelay: parseInt(process.env.LOCK_RETRY_DELAY || '200', 10)
      });

      // Set up event handlers
      this.redlock.on('clientError', (error) => {
        logger.error('[Lock Service] Redis client error:', {
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
      });

      this.startCleanupJob();
      this.initialized = true;
      logger.info('[Lock Service] Initialized successfully');
    } catch (error) {
      logger.error('[Lock Service] Initialization failed:', {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async acquireLock(resource, ttl = 30000) {
    if (!this.initialized) {
      await this.initialize();
    }

    const lockKey = `lock:${resource}`;
    this.incrementMetric(LOCK_METRICS.ACQUISITION_ATTEMPT);

    try {
      const lock = await this.redlock.acquire([lockKey], ttl);
      
      // Store lock information
      this.activeLocks.set(lockKey, {
        resource,
        lock,
        acquiredAt: Date.now(),
        ttl
      });

      this.incrementMetric(LOCK_METRICS.ACQUISITION_SUCCESS);
      
      logger.debug('[Lock Service] Lock acquired:', {
        resource,
        ttl,
        timestamp: new Date().toISOString()
      });

      return lock;
    } catch (error) {
      this.incrementMetric(LOCK_METRICS.ACQUISITION_FAILURE);
      
      logger.error('[Lock Service] Lock acquisition failed:', {
        resource,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      throw error;
    }
  }

  async releaseLock(resource) {
    const lockKey = `lock:${resource}`;
    const lockInfo = this.activeLocks.get(lockKey);

    if (!lockInfo) {
      logger.warn('[Lock Service] Attempted to release non-existent lock:', {
        resource,
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      await lockInfo.lock.release();
      this.activeLocks.delete(lockKey);
      this.incrementMetric(LOCK_METRICS.RELEASE_SUCCESS);

      logger.debug('[Lock Service] Lock released:', {
        resource,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      this.incrementMetric(LOCK_METRICS.RELEASE_FAILURE);
      
      logger.error('[Lock Service] Lock release failed:', {
        resource,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      throw error;
    }
  }

  async withLock(resource, operation, ttl = 30000) {
    let lock = null;
    try {
      lock = await this.acquireLock(resource, ttl);
      return await operation();
    } finally {
      if (lock) {
        try {
          await this.releaseLock(resource);
        } catch (error) {
          logger.error('[Lock Service] Error in withLock release:', {
            resource,
            error: error.message,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  }

  startCleanupJob() {
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleLocks()
        .catch(error => {
          logger.error('[Lock Service] Cleanup job failed:', {
            error: error.message,
            timestamp: new Date().toISOString()
          });
        });
    }, 60000);
  }

  async cleanupStaleLocks() {
    const now = Date.now();
    const staleLocks = [];

    for (const [key, lockInfo] of this.activeLocks.entries()) {
      if (now - lockInfo.acquiredAt > lockInfo.ttl) {
        staleLocks.push({
          key,
          lockInfo
        });
      }
    }

    if (staleLocks.length > 0) {
      logger.warn('[Lock Service] Found stale locks:', {
        count: staleLocks.length,
        locks: staleLocks.map(({ key }) => key),
        timestamp: new Date().toISOString()
      });

      for (const { key, lockInfo } of staleLocks) {
        try {
          await this.releaseLock(lockInfo.resource);
        } catch (error) {
          logger.error('[Lock Service] Failed to cleanup stale lock:', {
            resource: lockInfo.resource,
            error: error.message,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  }

  incrementMetric(metric) {
    const current = this.metrics.get(metric) || 0;
    this.metrics.set(metric, current + 1);
  }

  getMetrics() {
    const metrics = {};
    for (const [key, value] of this.metrics.entries()) {
      metrics[key] = value;
    }
    return metrics;
  }

  async cleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Release all active locks
    const releasePromises = Array.from(this.activeLocks.values())
      .map(lockInfo => this.releaseLock(lockInfo.resource)
        .catch(error => {
          logger.error('[Lock Service] Error releasing lock during cleanup:', {
            resource: lockInfo.resource,
            error: error.message,
            timestamp: new Date().toISOString()
          });
        })
      );

    await Promise.allSettled(releasePromises);
    this.activeLocks.clear();
    this.initialized = false;
  }
}

export const lockService = new LockService();
export default lockService; 