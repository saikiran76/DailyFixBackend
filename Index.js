import express from 'express';
import cors from 'cors';
import http from 'http';
import { createClient } from '@supabase/supabase-js';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { setIO } from './utils/socket.js';

import { initializeMatrixClient } from './services/matrixService.js';
import { initializePlatformBridge } from './services/matrixBridgeService.js';
import connectRoutes from './routes/connectRoutes.js';
import matrixRoomRoutes from './routes/matrixRoomRoutes.js';
import { bridges } from './services/matrixBridgeService.js';
import { errorHandler } from './middleware/errorHandler.js';
import { checkSystemHealth } from './services/healthCheck.js';
import {createTables} from './utils/supabase.js';
import authRoutes from './routes/authRoutes.js';
import accountRoutes from './routes/accountsRoutes.js';
import platformRoutes from './routes/platformRoutes.js';
import bridgeRoutes from './routes/bridgeRoutes.js';
import { initializeSocketServer } from './services/socketService.js';
import userRoutes from './routes/userRoutes.js';
import onboardingRoutes from './routes/onboardingRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import matrixRoutes from './routes/matrixRoutes.js';
import whatsappEntityRoutes from './routes/whatsappEntityRoutes.js';
import { syncJobService } from './services/syncJobService.js';

dotenv.config();

const port = process.env.PORT || 3001;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();

// Configure CORS first
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Then add other middleware
app.use(express.json());
app.use(cookieParser());

// Configure session middleware with proper settings
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  name: 'discord.oauth.sid', // Unique name to avoid conflicts
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Log session middleware initialization
console.log('Session middleware initialized with settings:', {
  cookieSecure: process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET ? 'set' : 'using fallback',
  timestamp: new Date().toISOString()
});

const server = http.createServer(app);

// Initialize socket.io with the server
const io = initializeSocketServer(server);

// Make io available to routes and set in socket utility
app.set('io', io);
setIO(io);

// Initialize Matrix clients and bridges
async function initializeServices() {
  try {
    // Verify database connection first
    const { data, error: dbError } = await supabase
      .from('accounts')
      .select('count')
      .limit(1);

    if (dbError) {
      console.error('Database connection error:', dbError);
      throw dbError;
    }

    // Get active Matrix accounts from Supabase
    const { data: matrixAccounts, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('platform', 'matrix')
      .eq('status', 'active');

    if (error) throw error;
    
    if (!matrixAccounts || matrixAccounts.length === 0) {
      console.log('No active Matrix accounts found');
      return;
    }

    for (const account of matrixAccounts) {
      await initializeMatrixClient(account.credentials.accessToken);
      
      // Get connected platforms
      const { data: connectedPlatforms, error: platformError } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', account.user_id)
        .eq('status', 'active')
        .in('platform', ['whatsapp', 'telegram']);

      if (platformError) throw platformError;

      for (const platformAccount of connectedPlatforms) {
        await initializePlatformBridge(account.user_id, platformAccount.platform);
      }
    }

    // Initialize WhatsApp sync job service
    console.log('Initializing WhatsApp sync job service...');
    await syncJobService.start();
    console.log('WhatsApp sync job service initialized successfully');

  } catch (error) {
    console.error('Matrix/Bridge/Sync initialization error:', error);
    throw error; // Propagate error for recovery mechanism
  }
}

// Add cleanup function
async function cleanup() {
  console.log('Cleaning up before shutdown...');
  
  try {
    // Cleanup all bridges
    for (const [key, bridge] of bridges.entries()) {
      await bridge.cleanup();
    }
    
    // Close any active realtime subscriptions
    const subscriptions = supabase.getSubscriptions();
    if (subscriptions && subscriptions.length > 0) {
      subscriptions.forEach(subscription => {
        supabase.removeSubscription(subscription);
      });
    }
    
    console.log('Cleanup completed');
    process.exit(0);
  } catch (error) {
    console.error('Cleanup error:', error);
    process.exit(1);
  }
}

// Add signal handlers
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Add health check endpoint
app.get('/health', async (req, res) => {
  const health = await checkSystemHealth();
  const status = health.database && Object.values(health.bridges)
    .every(bridge => bridge.connected) ? 200 : 503;
  res.status(status).json(health);
});

// Add global error handler
app.use(errorHandler);

// Add recovery mechanism
async function attemptRecovery() {
  console.log('Attempting system recovery...');
  try {
    await initializeServices();
    console.log('Recovery successful');
  } catch (error) {
    console.error('Recovery failed:', error);
    // Retry after delay
    setTimeout(attemptRecovery, 5000);
  }
}

// Initialize database and start server
async function initializeDatabase() {
  try {
    // Initialize Supabase tables
    await createTables();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

// Add routes in order of specificity
// Authentication routes first
app.use('/auth', authRoutes);

// Platform-specific routes
app.use('/matrix', matrixRoutes);
app.use('/api/whatsapp-entities', whatsappEntityRoutes);

// General platform and connection routes
app.use('/connect', connectRoutes);
app.use('/platforms', platformRoutes);
app.use('/bridge', bridgeRoutes);

// User and account management routes
app.use('/accounts', accountRoutes);
app.use('/user', userRoutes);
app.use('/onboarding', onboardingRoutes);

// Administrative routes
app.use('/admin', adminRoutes);
app.use('/reports', reportRoutes);

// Global error handler should be last
app.use(errorHandler);

// Start server only after database is initialized
async function startServer() {
  try {
    // Initialize database first
    await initializeDatabase();
    
    // Then initialize services
    await initializeServices();
    
    // Finally start the server
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    // Add retry mechanism
    if (error.message.includes('Table verification failed')) {
      console.log('Retrying database initialization in 5 seconds...');
      setTimeout(startServer, 5000);
    } else {
      process.exit(1);
    }
  }
}

startServer();

// Export supabase client for use in other files
export { supabase };