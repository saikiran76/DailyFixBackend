import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { adminClient } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { validateDiscordToken, refreshDiscordToken } from './directServices/discordDirect.js';
import { matrixWhatsAppService}  from './matrixWhatsAppService.js';
import { whatsappEntityService } from '../services/whatsappEntityService.js';
import { redisConfig, healthCheck, socketConfig } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { tokenService } from './tokenService.js';
import { redisClient } from './redisService.js';
import CircuitBreaker from 'opossum';
import { setupWhatsAppHandlers } from '../socket/whatsappHandler.js';

// Custom error class
class SocketError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

const messageQueues = new Map();

// Real-time metrics tracking
const metrics = {
  connections: new Map(),
  events: new Map(),
  errors: new Map(),
  latency: new Map(),
  retries: new Map()
};

// Add circuit breaker and enhanced monitoring
const CIRCUIT_BREAKER_OPTIONS = {
  timeout: 3000, // Time in ms before request is considered failed
  errorThresholdPercentage: 50, // Error rate % at which to open circuit
  resetTimeout: 30000, // Time in ms to wait before attempting reset
  rollingCountTimeout: 10000 // Time window in ms over which to count failures
};

// Enhanced metrics tracking
const enhancedMetrics = {
  ...metrics,
  circuitBreakers: new Map(),
  resourceUsage: {
    memory: new Map(),
    cpu: new Map()
  },
  performance: {
    responseTime: new Map(),
    throughput: new Map()
  }
};

// Helper to calculate average latency
const calculateAverageLatency = () => {
  if (metrics.latency.size === 0) return 0;
  const sum = Array.from(metrics.latency.values()).reduce((a, b) => a + b, 0);
  return Math.round(sum / metrics.latency.size);
};

// Track event metrics
const trackEvent = (event, latency = 0) => {
  metrics.events.set(event, (metrics.events.get(event) || 0) + 1);
  metrics.latency.set(event, (metrics.latency.get(event) || 0) + latency);
};

// Track error metrics
const trackError = (error) => {
  const errorType = error.type || 'unknown';
  metrics.errors.set(errorType, (metrics.errors.get(errorType) || 0) + 1);
};

// Enhanced error tracking with context
const enhancedTrackError = (error, context = {}) => {
  const errorType = error.type || 'unknown';
  metrics.errors.set(errorType, (metrics.errors.get(errorType) || 0) + 1);
  logger.error(`Socket error: ${error.message}`, { ...context, errorType });
};

// Enhanced event tracking with retry information
const enhancedTrackEvent = (event, latency = 0, retryCount = 0) => {
  metrics.events.set(event, (metrics.events.get(event) || 0) + 1);
  metrics.latency.set(event, (metrics.latency.get(event) || 0) + latency);
  if (retryCount > 0) {
    metrics.retries = metrics.retries || new Map();
    metrics.retries.set(event, (metrics.retries.get(event) || 0) + 1);
  }
};

// Socket authentication middleware
const authMiddleware = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new SocketError('auth', 'No token provided'));
    }

    const tokenData = await tokenService.getValidToken();
    if (!tokenData || tokenData.access_token !== token) {
      return next(new SocketError('auth', 'Invalid token'));
    }

    socket.userId = tokenData.userId;
    socket.tokenData = tokenData;

    // Subscribe to token updates
    socket.tokenUnsubscribe = tokenService.subscribe((newTokenData) => {
      socket.tokenData = newTokenData;
      socket.emit('token:refresh', { token: newTokenData.access_token });
    });

    next();
  } catch (error) {
    logger.error('Socket authentication error:', error);
    next(new SocketError('auth', 'Authentication failed'));
  }
};

// Performance monitoring
const trackPerformance = (operation, duration) => {
  const metrics = enhancedMetrics.performance.responseTime.get(operation) || {
    count: 0,
    total: 0,
    min: Infinity,
    max: -Infinity
  };

  metrics.count++;
  metrics.total += duration;
  metrics.min = Math.min(metrics.min, duration);
  metrics.max = Math.max(metrics.max, duration);
  metrics.average = metrics.total / metrics.count;

  enhancedMetrics.performance.responseTime.set(operation, metrics);
};

// Resource monitoring
const monitorResources = () => {
  const usage = process.memoryUsage();
  enhancedMetrics.resourceUsage.memory.set(Date.now(), {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss
  });
};

// Circuit breaker for Redis operations
const createRedisCircuitBreaker = (operation) => {
  const breaker = new CircuitBreaker(operation, CIRCUIT_BREAKER_OPTIONS);
  
  breaker.fallback(() => {
    logger.warn(`[Socket Service] Circuit breaker fallback for Redis operation`);
    return null;
  });

  breaker.on('success', () => {
    logger.debug(`[Socket Service] Redis operation succeeded`);
  });

  breaker.on('failure', (error) => {
    logger.error(`[Socket Service] Redis operation failed:`, error);
  });

  breaker.on('open', () => {
    logger.error(`[Socket Service] Circuit breaker opened for Redis operations`);
    ioEmitter.emit('system:alert', {
      type: 'circuit_breaker',
      status: 'open',
      service: 'redis'
    });
  });

  return breaker;
};

export async function initializeSocketServer(server) {
  try {
    // Initialize Redis service
    await redisClient.connect();

    const io = new Server(server, socketConfig);
    
    // Create Redis adapter using our Redis service
    io.adapter(createAdapter(redisClient.pubClient, redisClient.subClient));

    // Enhanced Redis error handling and monitoring
    redisClient.pubClient.on('error', (err) => {
      logger.error('Redis Pub Client Error:', {
        error: err,
        stack: err?.stack,
        timestamp: new Date().toISOString()
      });
      
      healthCheck.isConnected = false;
      healthCheck.addError(err);
      
      // Track error metrics
      enhancedMetrics.errors.set('redis_pub', (enhancedMetrics.errors.get('redis_pub') || 0) + 1);
      
      ioEmitter.emit('system:status', {
        type: 'redis',
        status: 'error',
        message: 'Redis connection error',
        timestamp: Date.now()
      });
    });

    // Start resource monitoring
    setInterval(monitorResources, 60000);

    // Enhanced metrics collection
    setInterval(async () => {
      try {
        const timestamp = Date.now();
        const metricsData = {
          activeConnections: enhancedMetrics.connections.size,
          eventCounts: Object.fromEntries(enhancedMetrics.events),
          errorCounts: Object.fromEntries(enhancedMetrics.errors),
          performance: {
            responseTime: Object.fromEntries(enhancedMetrics.performance.responseTime),
            throughput: Object.fromEntries(enhancedMetrics.performance.throughput)
          },
          resourceUsage: {
            memory: Object.fromEntries(enhancedMetrics.resourceUsage.memory),
            cpu: Object.fromEntries(enhancedMetrics.resourceUsage.cpu)
          },
          circuitBreakers: Array.from(enhancedMetrics.circuitBreakers.entries()).map(([name, breaker]) => ({
            name,
            state: breaker.opened ? 'open' : 'closed',
            failures: breaker.stats.failures,
            successes: breaker.stats.successes,
            fallbacks: breaker.stats.fallbacks
          })),
          timestamp
        };

        // Store metrics using Redis service
        await redisClient.publish('socket:metrics', JSON.stringify(metricsData));
      } catch (error) {
        logger.error('Error collecting metrics:', error);
      }
    }, 30000);

    // Socket middleware for authentication
    io.use(authMiddleware);

    // Connection handling
    io.on('connection', async (socket) => {
      try {
        const userId = socket.userId;
        logger.info(`[Socket Service] Client connected:`, {
          userId,
          socketId: socket.id
        });

        // Track connection
        enhancedMetrics.connections.set(socket.id, {
          userId,
          connectedAt: Date.now()
        });

        // Join user's room for targeted events
        socket.join(`user:${userId}`);

        // Set up WhatsApp handlers
        setupWhatsAppHandlers(io, socket);

        // Handle disconnection
        socket.on('disconnect', async () => {
          try {
            // Clean up token subscription
            if (socket.tokenUnsubscribe) {
              socket.tokenUnsubscribe();
            }

            // Remove from metrics
            enhancedMetrics.connections.delete(socket.id);

            logger.info(`[Socket Service] Client disconnected:`, {
              userId,
              socketId: socket.id
            });
          } catch (error) {
            logger.error('[Socket Service] Error handling disconnect:', error);
          }
        });

        // Handle errors
        socket.on('error', (error) => {
          enhancedTrackError(error, {
            userId,
            socketId: socket.id
          });
        });

      } catch (error) {
        logger.error('[Socket Service] Error handling connection:', error);
        socket.disconnect(true);
      }
    });

    return io;
  } catch (error) {
    logger.error('Failed to initialize socket server:', error);
    throw error;
  }
} 