import { supabase } from '../utils/supabase.js';
import { bridges } from './matrixBridgeService.js';
import { redisClient } from '../utils/redis.js';
import { tokenService } from './tokenService.js';
import { logger } from '../utils/logger.js';
import { databaseService } from './databaseService.js';
import { matrixService } from './matrixService.js';
import { adminClient } from '../utils/supabase.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

let lastHealthCheck = null;
const HEALTH_CHECK_DEBOUNCE = 5000; // 5 seconds

async function retryOperation(operation, name) {
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      logger.warn(`${name} check failed (attempt ${i + 1}/${MAX_RETRIES}):`, error);
      if (i < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}

export async function checkSystemHealth() {
  try {
    // Debounce health checks
    const now = Date.now();
    if (lastHealthCheck && (now - lastHealthCheck < HEALTH_CHECK_DEBOUNCE)) {
      return {
        status: 'debounced',
        timestamp: new Date().toISOString(),
        message: 'Health check debounced, too many requests'
      };
    }
    lastHealthCheck = now;

    const status = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: await checkDatabaseHealth(),
      redis: await checkRedisHealth(),
      tokenService: await checkTokenHealth(),
      bridges: await checkBridgeHealth()
    };

    // Only mark as degraded for critical services
    if (!status.database.connected || !status.redis.connected) {
      status.status = 'degraded';
    }

    return status;
  } catch (error) {
    logger.error('Health check failed:', error);
    return {
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

async function checkBridgeHealth() {
  try {
    // Get all active accounts with bridge rooms
    const { data: accounts, error } = await adminClient
      .from('accounts')
      .select('user_id, platform, credentials')
      .eq('status', 'active')
      .not('credentials->bridge_room_id', 'is', null);

    if (error) throw error;

    const bridges = {};
    const errors = [];
    
    for (const account of accounts) {
      const bridgeKey = `${account.platform}_${account.user_id}`;
      
      try {
        if (account.platform === 'matrix') {
          const client = await matrixService.getClient(account.user_id);
          const bridgeRoomId = account.credentials?.bridge_room_id;
          const room = client?.getRoom(bridgeRoomId);
          
          bridges[bridgeKey] = {
            status: room ? 'connected' : 'disconnected',
            lastCheck: new Date().toISOString(),
            bridgeRoomId,
            error: null
          };
        }
      } catch (error) {
        // Collect errors but don't log them individually
        errors.push({
          bridgeKey,
          error: error.message
        });
        
        bridges[bridgeKey] = {
          status: 'error',
          lastCheck: new Date().toISOString(),
          error: error.message
        };
      }
    }

    // Log all errors together to prevent log flooding
    if (errors.length > 0) {
      logger.error('Bridge health check errors:', { errors });
    }

    return bridges;
  } catch (error) {
    logger.error('Bridge health check failed:', error);
    return {};
  }
}

async function checkDatabaseHealth() {
  try {
    const health = await databaseService.healthCheck();
    return {
      connected: health.healthy,
      lastCheck: new Date().toISOString(),
      poolStats: health.poolStats
    };
  } catch (error) {
    return {
      connected: false,
      lastCheck: new Date().toISOString(),
      error: error.message
    };
  }
}

async function checkRedisHealth() {
  try {
    const connected = await redisClient.ping();
    return {
      connected,
      lastCheck: new Date().toISOString()
    };
  } catch (error) {
    return {
      connected: false,
      lastCheck: new Date().toISOString(),
      error: error.message
    };
  }
}

async function checkTokenHealth() {
  try {
    const token = await tokenService.getValidToken();
    return {
      valid: !!token,
      lastCheck: new Date().toISOString(),
      status: token ? 'valid' : 'no_session'
    };
  } catch (error) {
    return {
      valid: false,
      lastCheck: new Date().toISOString(),
      status: 'error',
      error: error.message
    };
  }
}

// Export a function to get a specific component's health
export async function getComponentHealth(component) {
  const health = await checkSystemHealth();
  return health[component] || { error: 'Component not found' };
} 