import { logger } from './logger';
import { getIO } from './socket';

export class LockHealthMonitor {
  constructor() {
    this.metrics = new Map();
    this.alerts = new Set();
    this.thresholds = {
      maxDuration: 30000,        // 30 seconds
      maxAttempts: 5,
      maxFailedReleases: 3,
      alertCleanupInterval: 3600000 // 1 hour
    };

    // Start alert cleanup
    setInterval(() => this.cleanupAlerts(), this.thresholds.alertCleanupInterval);
  }

  trackLock(key, data) {
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        acquisitions: 0,
        releases: 0,
        failedAcquisitions: 0,
        failedReleases: 0,
        totalDuration: 0,
        lastOperation: null,
        errors: []
      });
    }

    const metric = this.metrics.get(key);
    const timestamp = Date.now();

    switch (data.operation) {
      case 'acquire':
        metric.acquisitions++;
        metric.lastAcquired = timestamp;
        if (data.attempts > this.thresholds.maxAttempts) {
          this.emitAlert('HIGH_RETRY_COUNT', { key, attempts: data.attempts });
        }
        if (data.duration > this.thresholds.maxDuration) {
          this.emitAlert('SLOW_ACQUISITION', { key, duration: data.duration });
        }
        break;

      case 'release':
        metric.releases++;
        metric.totalDuration += data.duration;
        if (data.duration > this.thresholds.maxDuration) {
          this.emitAlert('LONG_LOCK_DURATION', { key, duration: data.duration });
        }
        break;

      case 'acquire_failed':
        metric.failedAcquisitions++;
        metric.errors.push({
          type: 'acquisition',
          error: data.error,
          timestamp
        });
        this.checkErrorThresholds(key, metric);
        break;

      case 'release_failed':
        metric.failedReleases++;
        metric.errors.push({
          type: 'release',
          error: data.error,
          timestamp
        });
        if (metric.failedReleases >= this.thresholds.maxFailedReleases) {
          this.emitAlert('MULTIPLE_RELEASE_FAILURES', { key, count: metric.failedReleases });
        }
        break;
    }

    metric.lastOperation = {
      type: data.operation,
      timestamp,
      ...data
    };

    // Cleanup old errors
    const oneHourAgo = Date.now() - 3600000;
    metric.errors = metric.errors.filter(error => error.timestamp > oneHourAgo);
  }

  checkErrorThresholds(key, metric) {
    const recentErrors = metric.errors.filter(
      error => error.timestamp > Date.now() - 300000 // Last 5 minutes
    );

    if (recentErrors.length >= 5) {
      this.emitAlert('HIGH_ERROR_RATE', {
        key,
        errorCount: recentErrors.length,
        timeWindow: '5 minutes'
      });
    }
  }

  emitAlert(type, data) {
    const alertId = `${type}:${data.key}:${Date.now()}`;
    if (this.alerts.has(alertId)) return;

    this.alerts.add(alertId);
    logger.error('[Lock Monitor] Alert:', { type, ...data });

    // Emit to socket if available
    const io = getIO();
    if (io) {
      io.emit('lock:alert', {
        type,
        ...data,
        timestamp: new Date().toISOString()
      });
    }
  }

  cleanupAlerts() {
    const oneHourAgo = Date.now() - 3600000;
    for (const alertId of this.alerts) {
      const [, , timestamp] = alertId.split(':');
      if (parseInt(timestamp) < oneHourAgo) {
        this.alerts.delete(alertId);
      }
    }
  }

  getMetrics(key) {
    return this.metrics.get(key);
  }

  getAllMetrics() {
    const result = {};
    for (const [key, metric] of this.metrics.entries()) {
      result[key] = { ...metric };
    }
    return result;
  }
}

// Export singleton instance
export const lockHealthMonitor = new LockHealthMonitor(); 