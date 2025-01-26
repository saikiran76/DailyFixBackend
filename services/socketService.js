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
import { redisService } from '../utils/redis.js';
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
  events: new Map(),
  errors: new Map(),
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
  enhancedMetrics.events.set(event, (enhancedMetrics.events.get(event) || 0) + 1);
  if (latency > 0) {
    enhancedMetrics.performance.responseTime.set(event, latency);
  }
};

// Track error metrics
const trackError = (error) => {
  const errorType = error.type || 'unknown';
  enhancedMetrics.errors.set(errorType, (enhancedMetrics.errors.get(errorType) || 0) + 1);
};

// Enhanced error tracking with context
const enhancedTrackError = (error, context = {}) => {
  const errorType = error.type || 'unknown';
  enhancedMetrics.errors.set(errorType, (enhancedMetrics.errors.get(errorType) || 0) + 1);
  logger.error(`Socket error: ${error.message}`, { ...context, errorType });
};

// Enhanced event tracking with retry information
const enhancedTrackEvent = (event, latency = 0, retryCount = 0) => {
  enhancedMetrics.events.set(event, (enhancedMetrics.events.get(event) || 0) + 1);
  if (latency > 0) {
    enhancedMetrics.performance.responseTime.set(event, latency);
  }
  if (retryCount > 0) {
    enhancedMetrics.retries = enhancedMetrics.retries || new Map();
    enhancedMetrics.retries.set(event, (enhancedMetrics.retries.get(event) || 0) + 1);
  }
};

const SOCKET_CONFIGS = {
  CONNECT_TIMEOUT: 15000,
  PING_INTERVAL: 25000,
  PING_TIMEOUT: 5000,
  MAX_RECONNECTION_ATTEMPTS: 5,
  RECONNECTION_DELAY: 1000,
  MAX_RECONNECTION_DELAY: 5000,
  DEVELOPMENT_MODE: process.env.NODE_ENV !== 'production'
};

// Monitor system resources
const monitorResources = () => {
  try {
    const usage = process.memoryUsage();
    enhancedMetrics.resourceUsage.memory.set('heapUsed', usage.heapUsed);
    enhancedMetrics.resourceUsage.memory.set('heapTotal', usage.heapTotal);
    enhancedMetrics.resourceUsage.memory.set('rss', usage.rss);
    
    // CPU usage (percentage of time spent in CPU out of total time)
    const startTime = process.hrtime();
    const startUsage = process.cpuUsage();
    
    setTimeout(() => {
      const elapsedTime = process.hrtime(startTime);
      const elapsedUsage = process.cpuUsage(startUsage);
      
      const totalTime = (elapsedTime[0] * 1e9 + elapsedTime[1]) / 1e6; // ms
      const cpuTime = (elapsedUsage.user + elapsedUsage.system) / 1000; // ms
      
      const cpuPercent = (cpuTime / totalTime) * 100;
      enhancedMetrics.resourceUsage.cpu.set('percentage', cpuPercent);
    }, 100);
  } catch (error) {
    logger.error('Error monitoring resources:', error);
  }
};

// Helper to safely convert Map to object
const safeMapToObject = (map) => {
  if (!(map instanceof Map)) {
    logger.warn('Expected Map but got:', { type: typeof map, value: map });
    return {};
  }
  try {
    return Object.fromEntries(map);
  } catch (error) {
    logger.error('Error converting Map to object:', error);
    return {};
  }
};

class SocketService {
  constructor() {
    this.io = null;
    this.connections = new Map();
    this.healthChecks = new Map();
    this.initialized = false;
    this.monitoringInterval = null;
  }

  async initialize(server) {
    try {
      logger.info('[Socket] Initializing socket service...');
      
      this.io = new Server(server, {
        pingInterval: SOCKET_CONFIGS.PING_INTERVAL,
        pingTimeout: SOCKET_CONFIGS.PING_TIMEOUT,
        connectTimeout: SOCKET_CONFIGS.CONNECT_TIMEOUT,
        reconnection: true,
        reconnectionAttempts: SOCKET_CONFIGS.MAX_RECONNECTION_ATTEMPTS,
        reconnectionDelay: SOCKET_CONFIGS.RECONNECTION_DELAY,
        reconnectionDelayMax: SOCKET_CONFIGS.MAX_RECONNECTION_DELAY,
        cors: {
          origin: process.env.FRONTEND_URL || 'http://localhost:5173',
          methods: ['GET', 'POST'],
          credentials: true
        }
      });

      // Get Redis pub/sub clients
      const pubClient = redisService.getPubClient();
      const subClient = redisService.getSubClient();
      
      // Create Redis adapter
      const redisAdapter = createAdapter(pubClient, subClient);
      
      // Set up Socket.IO with Redis adapter
      this.io.adapter(redisAdapter);

      // Enhanced Redis error handling
      redisService.pubClient.on('error', (err) => {
      logger.error('Redis Pub Client Error:', {
        error: err,
        stack: err?.stack,
        timestamp: new Date().toISOString()
      });
        enhancedTrackError(err, { type: 'redis_pub' });
      });

      // Start monitoring
      this.startMonitoring();
      
      // Enhanced authentication middleware
      this.io.use(async (socket, next) => {
        try {
          const token = socket.handshake.auth.token;
          
          if (!token) {
            if (SOCKET_CONFIGS.DEVELOPMENT_MODE) {
              logger.warn('[Socket] No token provided, allowing in development mode');
              socket.userId = 'anonymous';
              socket.userData = { anonymous: true };
              return next();
            }
            return next(new Error('Authentication token required'));
          }

          try {
            const { data: { user }, error } = await adminClient.auth.getUser(token);
            
            if (error || !user) {
              if (SOCKET_CONFIGS.DEVELOPMENT_MODE) {
                logger.warn('[Socket] Invalid token, allowing in development mode');
                socket.userId = 'anonymous';
                socket.userData = { anonymous: true };
                return next();
              }
              return next(new Error('Invalid authentication token'));
            }

            // Valid user authentication
            socket.userId = user.id;
            socket.userData = user;
            this.trackConnection(socket);
            
            logger.info('[Socket] User authenticated successfully:', {
              userId: user.id,
              socketId: socket.id
            });
            
            next();
          } catch (authError) {
            logger.error('[Socket] Authentication error:', authError);
            if (SOCKET_CONFIGS.DEVELOPMENT_MODE) {
              socket.userId = 'anonymous';
              socket.userData = { anonymous: true };
              return next();
            }
            next(new Error('Authentication failed'));
          }
        } catch (error) {
          logger.error('[Socket] Critical socket error:', error);
          next(new Error('Internal server error'));
        }
      });

      // Set up connection handling
      this.io.on('connection', (socket) => {
        this.setupSocketHandlers(socket);
        logger.info('[Socket] New connection established:', {
          socketId: socket.id,
          userId: socket.userId
      });
    });

      this.initialized = true;
      logger.info('[Socket] Socket service initialized successfully');
      
      return this;
    } catch (error) {
      logger.error('[Socket] Failed to initialize socket service:', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  startMonitoring() {
    // Start resource monitoring
    monitorResources(); // Initial monitoring
    this.monitoringInterval = setInterval(monitorResources, 60000);

    // Start metrics collection
    setInterval(async () => {
      try {
        const timestamp = Date.now();
        
        // Safely collect metrics
        const eventCounts = safeMapToObject(enhancedMetrics.events);
        const errorCounts = safeMapToObject(enhancedMetrics.errors);
        const responseTime = safeMapToObject(enhancedMetrics.performance.responseTime);
        const throughput = safeMapToObject(enhancedMetrics.performance.throughput);
        const memory = safeMapToObject(enhancedMetrics.resourceUsage.memory);
        const cpu = safeMapToObject(enhancedMetrics.resourceUsage.cpu);

        const metricsData = {
          eventCounts,
          errorCounts,
          performance: {
            responseTime,
            throughput
          },
          resourceUsage: {
            memory,
            cpu
          },
          timestamp
        };

        logger.debug('Collecting metrics:', metricsData);
        
        // Get Redis pub client and publish metrics
        const pubClient = redisService.getPubClient();
        if (!pubClient) {
          throw new Error('Redis pub client not available');
        }
        await pubClient.publish('socket:metrics', JSON.stringify(metricsData));
      } catch (error) {
        logger.error('Error collecting metrics:', {
          error: error.message,
          stack: error.stack,
          metrics: {
            events: enhancedMetrics.events?.size,
            errors: enhancedMetrics.errors?.size,
            responseTime: enhancedMetrics.performance?.responseTime?.size,
            throughput: enhancedMetrics.performance?.throughput?.size,
            memory: enhancedMetrics.resourceUsage?.memory?.size,
            cpu: enhancedMetrics.resourceUsage?.cpu?.size
          }
        });
      }
    }, 30000);
  }

  async cleanup() {
    try {
      if (this.io) {
        // Stop monitoring
        if (this.monitoringInterval) {
          clearInterval(this.monitoringInterval);
          this.monitoringInterval = null;
        }

        // Close all connections
        const sockets = await this.io.fetchSockets();
        await Promise.all(sockets.map(socket => socket.disconnect(true)));
        
        // Close the server
        await new Promise((resolve) => {
          this.io.close(() => {
            logger.info('[Socket] Socket.IO server closed');
            resolve();
          });
        });
        
        this.io = null;
        this.connections.clear();
        this.healthChecks.clear();
        this.initialized = false;
      }
    } catch (error) {
      logger.error('[Socket] Error during cleanup:', error);
      throw error;
    }
  }

  trackConnection(socket) {
    const userId = socket.userId;
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId).add(socket.id);

    // Setup cleanup on disconnect
    socket.on('disconnect', () => {
      const userConnections = this.connections.get(userId);
      if (userConnections) {
        userConnections.delete(socket.id);
        if (userConnections.size === 0) {
          this.connections.delete(userId);
        }
      }
    });
  }

  setupSocketHandlers(socket) {
    // Handle ping manually for better connection monitoring
    socket.on('ping', () => {
      socket.emit('pong');
      this.updateLastActivity(socket);
    });

        // Handle errors
        socket.on('error', (error) => {
      logger.error('[Socket] Client error:', {
        userId: socket.userId,
        socketId: socket.id,
        error: error.message
          });
        });

    // Handle reconnection
    socket.on('reconnect_attempt', (attempt) => {
      logger.info('[Socket] Reconnection attempt:', {
        userId: socket.userId,
        socketId: socket.id,
        attempt
      });
    });

    // Handle successful reconnection
    socket.on('reconnect', () => {
      logger.info('[Socket] Reconnected successfully:', {
        userId: socket.userId,
        socketId: socket.id
      });
      this.updateLastActivity(socket);
    });
  }

  updateLastActivity(socket) {
    const key = `socket:activity:${socket.id}`;
    redisService.pubClient.set(key, Date.now(), 'EX', 300); // Store for 5 minutes
  }
}

// Export a function that creates and initializes a socket service instance
export async function initializeSocketServer(server) {
  const socketService = new SocketService();
  return socketService.initialize(server);
} 