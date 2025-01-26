import { logger } from './logger';
import { redisClient } from './redis';

export class LockCleanupService {
  constructor(lockManager) {
    this.lockManager = lockManager;
    this.cleanupInterval = 60000; // 1 minute
    this.staleLockTimeout = lockManager.config.staleLockTimeout;
    
    // Start periodic cleanup
    this.intervalId = setInterval(() => this.cleanup(), this.cleanupInterval);
    
    // Track cleanup metrics
    this.metrics = {
      lastRun: null,
      cleanupsPerformed: 0,
      locksReleased: 0,
      errors: []
    };
  }

  async cleanup() {
    const start = Date.now();
    let releasedCount = 0;
    let errorCount = 0;

    try {
      logger.info('[Lock Cleanup] Starting cleanup cycle');

      // Get all current locks
      const currentLocks = Array.from(this.lockManager.locks.entries());

      for (const [key, lockInfo] of currentLocks) {
        try {
          const lockAge = Date.now() - lockInfo.acquiredAt;

          // Check if lock is stale
          if (lockAge > this.staleLockTimeout) {
            logger.warn('[Lock Cleanup] Found stale lock:', {
              key,
              age: lockAge,
              threshold: this.staleLockTimeout
            });

            // Attempt to force release
            await this.lockManager._forceRelease(lockInfo.lock, key);
            releasedCount++;

            // Track in health monitor
            this.lockManager.healthMonitor.trackLock(key, {
              operation: 'cleanup_release',
              duration: lockAge
            });
          }
        } catch (error) {
          errorCount++;
          logger.error('[Lock Cleanup] Error cleaning up lock:', {
            key,
            error: error.message
          });

          this.metrics.errors.push({
            timestamp: Date.now(),
            key,
            error: error.message
          });
        }
      }

      // Update metrics
      this.metrics.lastRun = Date.now();
      this.metrics.cleanupsPerformed++;
      this.metrics.locksReleased += releasedCount;

      // Cleanup old errors
      const oneHourAgo = Date.now() - 3600000;
      this.metrics.errors = this.metrics.errors.filter(
        error => error.timestamp > oneHourAgo
      );

      logger.info('[Lock Cleanup] Cleanup cycle completed:', {
        duration: Date.now() - start,
        locksChecked: currentLocks.length,
        locksReleased: releasedCount,
        errors: errorCount
      });

    } catch (error) {
      logger.error('[Lock Cleanup] Critical error during cleanup:', error);
      
      // Track in health monitor
      this.lockManager.healthMonitor.emitAlert('CLEANUP_CRITICAL_ERROR', {
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  async forceCleanup(key) {
    try {
      const lockInfo = this.lockManager.locks.get(key);
      if (!lockInfo) {
        logger.warn('[Lock Cleanup] Lock not found for force cleanup:', { key });
        return false;
      }

      await this.lockManager._forceRelease(lockInfo.lock, key);
      
      logger.info('[Lock Cleanup] Force cleanup successful:', { key });
      return true;

    } catch (error) {
      logger.error('[Lock Cleanup] Force cleanup failed:', {
        key,
        error: error.message
      });
      
      this.lockManager.healthMonitor.emitAlert('FORCE_CLEANUP_FAILED', {
        key,
        error: error.message
      });
      
      return false;
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeLocks: this.lockManager.locks.size
    };
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// Note: Don't create singleton instance here as it needs lockManager reference 