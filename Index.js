import express from 'express';
import cors from 'cors';
import http from 'http';
import { createClient } from '@supabase/supabase-js';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import RedisStore from 'connect-redis';

// Import logger first as it's used by other services
import logger from './utils/logger.js';

// Import configuration
import { config } from './config/config.js';
import { redisClient } from './services/redisService.js';

// Import core services
import { databaseService } from './services/databaseService.js';
import { rateLimiterService } from './services/rateLimiterService.js';
import { initializeSocketServer } from './services/socketService.js';
import { setIO } from './utils/socket.js';

// Import initialization services
import { initializeMatrixClient } from './services/matrixService.js';
import { initializePlatformBridge, bridges } from './services/matrixBridgeService.js';
import { checkSystemHealth } from './services/healthCheck.js';
import { createTables } from './utils/supabase.js';
import { syncJobService } from './services/syncJobService.js';
import { tokenService } from './services/tokenService.js';
import { startWhatsAppSyncJob } from './services/whatsappEntityService.js';

// Import middleware
import { requestHandler, errorHandler } from './middleware/requestHandler.js';

// Import routes
import authRoutes from './routes/authRoutes.js';
import accountsRoutes from './routes/accountsRoutes.js';
import userRoutes from './routes/userRoutes.js';
import onboardingRoutes from './routes/onboardingRoutes.js';
import connectRoutes from './routes/connectRoutes.js';
import platformRoutes from './routes/platformRoutes.js';
import bridgeRoutes from './routes/bridgeRoutes.js';
import matrixRoutes from './routes/matrixRoutes.js';
import whatsappEntityRoutes from './routes/whatsappEntityRoutes.js';
import aiAnalysisRoutes from './routes/aiAnalysis.js';

dotenv.config();

const port = process.env.PORT || 3001;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Declare socketServer at the top level for access in cleanup
let socketServer = null;

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', {
    promise: promise,
    reason: reason,
    stack: reason?.stack
  });
  // Don't exit, let the process continue
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', {
    error: error,
    stack: error?.stack
  });
  // Initiate graceful shutdown
  cleanup().catch(err => {
    logger.error('Cleanup failed during uncaught exception handler:', err);
  }).finally(() => {
    process.exit(1);
  });
});

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Apply security middleware
app.use(helmet());
app.use(compression());

// Configure CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

// Apply basic middleware
app.use(express.json());
app.use(cookieParser());

// Initialize core services
async function initializeServices() {
  try {
    logger.info('Initializing core services...');

    // Initialize Redis first (if not already connected)
    if (!redisClient.getConnectionStatus()) {
      await redisClient.connect();
      logger.info('Redis service initialized');
    }

    // Configure session with Redis
    app.use(session({
      store: new RedisStore({ 
        client: redisClient.client,
        prefix: 'sess:'
      }),
      secret: process.env.SESSION_SECRET || 'your-secret-key',
      resave: false,
      saveUninitialized: false,
      name: 'dailyfix.sid',
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));

    // Initialize token service with graceful degradation
    await tokenService.initialize();
    logger.info('Token service initialized:', { 
      hasActiveSession: !!tokenService.activeSession 
    });

    // Initialize socket service
    try {
      socketServer = await initializeSocketServer(server);
      if (!socketServer) {
        throw new Error('Socket server initialization returned null');
      }
      logger.info('Socket service initialized successfully');
    } catch (socketError) {
      logger.error('Failed to initialize socket server:', {
        error: socketError.message,
        stack: socketError.stack
      });
      throw socketError;
    }

    // Start server
    await new Promise((resolve, reject) => {
      server.listen(port, (err) => {
        if (err) {
          reject(err);
          return;
        }
        logger.info(`Server is running on port ${port}`);
        resolve();
      });
    });

    return true;
  } catch (error) {
    logger.error('Failed to initialize services:', {
      error: error.message,
      stack: error.stack
    });
    await cleanup();
    throw error;
  }
}

// Consolidated cleanup function
async function cleanup() {
  logger.info('Starting cleanup...');
  try {
    // Cleanup socket service first
    if (socketServer) {
      try {
        await socketServer.cleanup();
        logger.info('Socket service cleaned up');
      } catch (socketError) {
        logger.error('Error cleaning up socket service:', {
          error: socketError.message,
          stack: socketError.stack
        });
      }
    }
    
    // Cleanup token service
    if (tokenService) {
      try {
        tokenService.destroy();
        logger.info('Token service cleaned up');
      } catch (tokenError) {
        logger.error('Error cleaning up token service:', {
          error: tokenError.message,
          stack: tokenError.stack
        });
      }
    }
    
    // Disconnect Redis clients last
    try {
      await redisClient.disconnect();
      logger.info('Redis clients disconnected successfully');
    } catch (redisError) {
      logger.error('Error disconnecting Redis clients:', {
        error: redisError.message,
        stack: redisError.stack
      });
    }
    
    logger.info('Cleanup completed');
  } catch (error) {
    logger.error('Error during cleanup:', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// Apply custom middleware
app.use(requestHandler);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbHealth = await databaseService.healthCheck();
    const status = {
      service: 'dailyfix-backend',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      redis: {
        connected: await redisClient.ping(),
        lastCheck: new Date().toISOString()
      },
      database: {
        connected: dbHealth.healthy,
        lastCheck: new Date().toISOString(),
        poolStats: {
          size: dbHealth.poolSize,
          waiting: dbHealth.waiting,
          idle: dbHealth.idle
        }
      },
      tokenService: {
        valid: tokenService.initialized,
        status: tokenService.initialized ? 'ready' : 'initializing',
        lastCheck: new Date().toISOString()
      },
      bridges: {}
    };

    res.json(status);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Add routes
app.use('/auth', authRoutes);
app.use('/matrix', matrixRoutes);
app.use('/api/whatsapp-entities', whatsappEntityRoutes);
app.use('/connect', connectRoutes);
app.use('/platforms', platformRoutes);
app.use('/bridge', bridgeRoutes);
app.use('/accounts', accountsRoutes);
app.use('/user', userRoutes);
app.use('/onboarding', onboardingRoutes);
app.use('/api/analysis', aiAnalysisRoutes);

// Add error handler last
app.use(errorHandler);

// Start the application
initializeServices().catch(error => {
  logger.error('Application startup failed:', error);
  process.exit(1);
});

// Export supabase client for use in other files
export { supabase };