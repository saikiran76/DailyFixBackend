import express from 'express';
import cors from 'cors';
import http from 'http';
import { createClient } from '@supabase/supabase-js';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';

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

// Define cleanup function at the top level
const cleanup = async () => {
  logger.info('Starting cleanup...');
  try {
    await Promise.all([
      redisClient.disconnect(),
      databaseService.cleanup()
    ]);
    logger.info('Cleanup completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during cleanup:', error);
    process.exit(1);
  }
};

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

// Configure session with Redis
import RedisStore from 'connect-redis';

// Initialize Redis before setting up session
await redisClient.connect();

app.use(session({
  store: new RedisStore({ 
    client: redisClient.client, // Use the client property directly
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

// Apply custom middleware
app.use(requestHandler);

const server = http.createServer(app);

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
        valid: false,
        status: 'initializing',
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

// Initialize core services
async function initializeServices() {
  try {
    logger.info('Initializing core services...');

    // Initialize Redis
    await redisClient.connect();
    logger.info('Redis service initialized');

    // Initialize token service and verify it has a valid session
    const tokenData = await tokenService.getValidToken();
    if (!tokenData) {
      logger.warn('Token service initialized without active session');
    } else {
      logger.info('Token service initialized with valid session');
    }

    // Initialize Socket.IO with Redis adapter
    const io = await initializeSocketServer(server);
    logger.info('Socket.IO service initialized');

    // Verify database connection
    const dbHealth = await databaseService.healthCheck();
    if (!dbHealth.healthy) {
      throw new Error('Database health check failed');
    }
    logger.info('Database connection verified');

    // Initialize database tables
    console.log('Initializing database tables...');
    await databaseService.initializeTables();
    console.log('Database initialization completed successfully');
    logger.info('Database tables initialized');

    // Initialize Matrix clients and bridges
    const { data: matrixAccounts, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('platform', 'matrix')
      .eq('status', 'active');

    if (error) throw error;
    
    if (matrixAccounts && matrixAccounts.length > 0) {
      for (const account of matrixAccounts) {
        const { credentials } = account;
        await initializeMatrixClient(credentials.accessToken, credentials.userId);
        logger.info(`Matrix client initialized for user: ${account.user_id}`);
      }
    }

    // Start WhatsApp sync job service
    console.log('Starting WhatsApp sync job service');
    await startWhatsAppSyncJob();
    logger.info('WhatsApp sync job service initialized');

    // Start server
    server.listen(port, () => {
      logger.info(`Server running on port ${port}`);
      
      // 5. Emit server ready event
      io.emit('system:status', {
        type: 'server',
        status: 'ready',
        timestamp: new Date().toISOString()
      });
    });

    // Set up cleanup on process exit
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Schedule periodic health checks
    const healthCheckInterval = setInterval(async () => {
      try {
        const health = await checkSystemHealth();
        if (!health.healthy) {
          logger.warn('System health check failed:', health);
        }
      } catch (error) {
        logger.error('Health check error:', error);
      }
    }, 30000).unref(); // Don't prevent process exit

    // Cleanup health check on shutdown
    const cleanupHealthCheck = () => {
      clearInterval(healthCheckInterval);
    };
    process.on('SIGTERM', cleanupHealthCheck);
    process.on('SIGINT', cleanupHealthCheck);

  } catch (error) {
    logger.error('Failed to initialize services:', error);
    await cleanup();
    process.exit(1);
  }
}

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