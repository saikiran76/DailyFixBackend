import createConnectionPool, { sql } from '@databases/pg';
import { logger } from '../utils/logger.js';

// Track connection state
let isConnected = false;
let lastError = null;
let lastCheck = null;

// Connection pool configuration
const pool = createConnectionPool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  bigIntMode: 'number',  // Set explicitly to avoid warning
  maxPoolSize: 20,       // Maximum number of connections
  minPoolSize: 2,        // Minimum number of idle connections
  idleTimeoutMillis: 30000,         // Idle connections timeout (30 seconds)
  connectionTimeoutMillis: 2000,     // Connection acquisition timeout
  maxUses: 10000,                   // Maximum queries per connection
  
  // Query configuration
  statement_timeout: 60000,         // Statement timeout (1 minute)
  query_timeout: 60000,            // Query timeout (1 minute)
  
  // Application identification
  application_name: 'DailyFixBackend',
  
  // Connection retry configuration
  retryDelay: 1000,               // Delay between retries
  maxRetries: 3,                  // Maximum number of retries
  
  onError: (error) => {
    isConnected = false;
    lastError = error;
    logger.error('[Database] Connection error:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});

// Non-blocking health check
export const getPoolStats = async () => {
  try {
    // Only check every 5 seconds
    const now = Date.now();
    if (lastCheck && (now - lastCheck < 5000)) {
      return {
        status: isConnected ? 'connected' : 'degraded',
        maxConnections: 20,
        healthy: isConnected,
        lastError: lastError?.message,
        lastCheck: new Date(lastCheck).toISOString()
      };
    }

    // Attempt connection check with timeout
    const checkPromise = pool.query(sql`SELECT 1 as connected`);
    const result = await Promise.race([
      checkPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 2000))
    ]).catch(error => {
      // On error or timeout, return null but don't fail
      logger.warn('[Database] Connection check warning:', { error: error.message });
      return null;
    });

    isConnected = result?.[0]?.connected === 1;
    if (isConnected) {
      lastError = null;
    }
    lastCheck = now;

    return {
      status: isConnected ? 'connected' : 'degraded',
      maxConnections: 20,
      healthy: isConnected,
      lastError: lastError?.message,
      lastCheck: new Date(now).toISOString()
    };
  } catch (error) {
    isConnected = false;
    lastError = error;
    lastCheck = Date.now();
    logger.warn('[Database] Connection check warning:', { error: error.message });
    
    return {
      status: 'degraded',
      maxConnections: 20,
      healthy: false,
      lastError: error.message,
      lastCheck: new Date(lastCheck).toISOString()
    };
  }
};

// Wrapper for query execution with fallback
export const executeQuery = async (query, params = [], options = {}) => {
  try {
    return await pool.query(query, params);
  } catch (error) {
    if (!options.suppressError) {
      logger.error('[Database] Query error:', {
        error: error.message,
        query: query.text || query,
        params,
        timestamp: new Date().toISOString()
      });
    }
    throw error;
  }
};

export { sql };
export default pool; 