import { RateLimiterMemory } from 'rate-limiter-flexible';
import logger from './logger.js';

const RATE_LIMITS = {
  DEFAULT: {
    points: 60,      // Number of points
    duration: 60,    // Per 60 seconds
    blockDuration: 60 // Block for 60 seconds if exceeded
  },
  HIGH_PRIORITY: {
    points: 120,
    duration: 60,
    blockDuration: 30
  },
  LOW_PRIORITY: {
    points: 30,
    duration: 60,
    blockDuration: 120
  }
};

class RateLimiterService {
  constructor() {
    // Initialize rate limiters for different priorities
    this.limiters = new Map();
    
    // Create default limiter
    this.defaultLimiter = new RateLimiterMemory({
      ...RATE_LIMITS.DEFAULT,
      keyPrefix: 'default'
    });

    // Create priority-based limiters
    this.limiters.set('high', new RateLimiterMemory({
      ...RATE_LIMITS.HIGH_PRIORITY,
      keyPrefix: 'high'
    }));

    this.limiters.set('default', this.defaultLimiter);

    this.limiters.set('low', new RateLimiterMemory({
      ...RATE_LIMITS.LOW_PRIORITY,
      keyPrefix: 'low'
    }));

    // Track active requests
    this.activeRequests = new Map();
  }

  async consume(key, points = 1, priority = 'default') {
    const limiter = this.limiters.get(priority) || this.defaultLimiter;
    
    try {
      const rateLimiterRes = await limiter.consume(key, points);
      
      // Track active request
      this.trackRequest(key, priority);
      
      return {
        success: true,
        remainingPoints: rateLimiterRes.remainingPoints,
        msBeforeNext: rateLimiterRes.msBeforeNext
      };
    } catch (error) {
      if (error instanceof Error) {
        logger.error('Rate limiter error:', error);
        throw error;
      }
      
      // RateLimiterRes error
      return {
        success: false,
        msBeforeNext: error.msBeforeNext,
        remainingPoints: 0
      };
    }
  }

  trackRequest(key, priority) {
    if (!this.activeRequests.has(key)) {
      this.activeRequests.set(key, {
        count: 0,
        priority,
        firstRequest: Date.now()
      });
    }
    
    const request = this.activeRequests.get(key);
    request.count++;
    request.lastRequest = Date.now();
  }

  async cleanup(key) {
    this.activeRequests.delete(key);
  }

  getActiveRequestsCount(key) {
    const request = this.activeRequests.get(key);
    return request ? request.count : 0;
  }

  getRequestStats(key) {
    const request = this.activeRequests.get(key);
    if (!request) {
      return null;
    }

    return {
      count: request.count,
      priority: request.priority,
      duration: Date.now() - request.firstRequest,
      lastRequest: request.lastRequest
    };
  }

  async block(key, duration, priority = 'default') {
    const limiter = this.limiters.get(priority) || this.defaultLimiter;
    try {
      await limiter.block(key, duration);
      return true;
    } catch (error) {
      logger.error('Error blocking key:', error);
      return false;
    }
  }

  async get(key, priority = 'default') {
    const limiter = this.limiters.get(priority) || this.defaultLimiter;
    try {
      const res = await limiter.get(key);
      return res;
    } catch (error) {
      logger.error('Error getting rate limiter info:', error);
      return null;
    }
  }

  async delete(key, priority = 'default') {
    const limiter = this.limiters.get(priority) || this.defaultLimiter;
    try {
      await limiter.delete(key);
      this.cleanup(key);
      return true;
    } catch (error) {
      logger.error('Error deleting rate limiter key:', error);
      return false;
    }
  }
}

// Export singleton instance
export const rateLimiterService = new RateLimiterService(); 