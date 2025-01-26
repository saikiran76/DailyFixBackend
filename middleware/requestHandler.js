import { rateLimiterService } from '../services/rateLimiterService.js';
import { databaseService } from '../services/databaseService.js';
import logger from '../services/logger.js';

// Constants for request priorities and limits
const REQUEST_PRIORITIES = {
  '/api/sync': 'high',
  '/api/messages': 'high',
  '/api/contacts': 'high',
  '/api/auth': 'high',
  'default': 'default'
};

const COST_MULTIPLIERS = {
  'GET': 1,
  'POST': 2,
  'PUT': 2,
  'DELETE': 3,
  'default': 1
};

export const requestHandler = async (req, res, next) => {
  const startTime = Date.now();
  const requestId = `${req.ip}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Attach utilities to the request object
  req.context = {
    requestId,
    startTime,
    db: databaseService
  };

  try {
    // Determine request priority and cost
    const priority = getRequestPriority(req.path);
    const costMultiplier = COST_MULTIPLIERS[req.method] || COST_MULTIPLIERS.default;
    
    // Check rate limit
    const rateLimitResult = await rateLimiterService.consume(
      req.ip,
      costMultiplier,
      priority
    );

    if (!rateLimitResult.success) {
      logger.warn('Rate limit exceeded:', {
        ip: req.ip,
        path: req.path,
        msBeforeNext: rateLimitResult.msBeforeNext
      });

      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil(rateLimitResult.msBeforeNext / 1000)
      });
    }

    // Check database health
    const dbHealth = await databaseService.healthCheck();
    if (!dbHealth.healthy) {
      logger.error('Database health check failed:', dbHealth.error);
      // return res.status(503).json({
      //   error: 'Service temporarily unavailable',
      //   details: 'Database connection issues'
      // });
    }

    // Intercept response to track metrics
    const originalSend = res.send;
    res.send = function(data) {
      const duration = Date.now() - startTime;
      
      // Log request metrics
      logger.info('Request completed', {
        requestId,
        method: req.method,
        path: req.path,
        duration,
        status: res.statusCode,
        priority
      });

      // Cleanup
      rateLimiterService.cleanup(req.ip);
      
      originalSend.call(this, data);
    };

    // Add response helpers
    res.success = function(data, status = 200) {
      return res.status(status).json({
        success: true,
        data
      });
    };

    res.error = function(message, status = 400, details = null) {
      return res.status(status).json({
        success: false,
        error: message,
        details
      });
    };

    next();
  } catch (error) {
    logger.error('Request handler error:', {
      requestId,
      error: error.message,
      stack: error.stack
    });

    // Cleanup on error
    rateLimiterService.cleanup(req.ip);

    return res.status(500).json({
      error: 'Internal server error',
      requestId
    });
  }
};

function getRequestPriority(path) {
  // Check for exact matches first
  if (REQUEST_PRIORITIES[path]) {
    return REQUEST_PRIORITIES[path];
  }

  // Check for path patterns
  for (const [pattern, priority] of Object.entries(REQUEST_PRIORITIES)) {
    if (pattern !== 'default' && path.startsWith(pattern)) {
      return priority;
    }
  }

  return REQUEST_PRIORITIES.default;
}

// Error handling middleware
export const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error:', {
    requestId: req.context?.requestId,
    error: err.message,
    stack: err.stack
  });

  // Cleanup
  if (req.ip) {
    rateLimiterService.cleanup(req.ip);
  }

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.context?.requestId
  });
}; 