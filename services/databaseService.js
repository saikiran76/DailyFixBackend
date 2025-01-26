import { createClient } from '@supabase/supabase-js';
import pool, { sql, getPoolStats, executeQuery } from '../config/database.js';
import logger from './logger.js';

// Enhanced pool configuration with optimized settings
const POOL_CONFIG = {
  MIN_POOL_SIZE: 2,
  MAX_POOL_SIZE: 20,
  IDLE_TIMEOUT: 30000,
  CONNECTION_TIMEOUT: 5000,
  MAX_USES_PER_CONNECTION: 7500,
  QUEUE_TIMEOUT: 10000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  HEALTH_CHECK_INTERVAL: 30000
};

// Error types for better error handling
const DB_ERROR_TYPES = {
  CONNECTION_ERROR: 'connection_error',
  QUERY_ERROR: 'query_error',
  POOL_ERROR: 'pool_error',
  TIMEOUT_ERROR: 'timeout_error'
};

class DatabaseService {
  constructor() {
    // Initialize metrics
    this.metrics = {
      activeConnections: 0,
      idleConnections: 0,
      waitingClients: 0,
      errorCount: 0,
      lastHealthCheck: null,
      isHealthy: true
    };

    // Initialize Supabase clients
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    this.adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // Start health checks
    this.startHealthChecks();

    this.retryOptions = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 5000
    };
  }

  // Enhanced error handling
  handlePoolError(error) {
    logger.error('Database pool error:', error);
    
    if (this.isConnectionError(error)) {
      this.metrics.isHealthy = false;
      this.attemptReconnection();
    }
  }

  // Check if error is connection-related
  isConnectionError(error) {
    return error.code === 'PROTOCOL_CONNECTION_LOST' ||
           error.code === 'ECONNREFUSED' ||
           error.code === 'ETIMEDOUT';
  }

  // Attempt reconnection with exponential backoff
  async attemptReconnection(attempt = 0) {
    if (attempt >= POOL_CONFIG.RETRY_ATTEMPTS) {
      logger.error('Max reconnection attempts reached');
      return false;
    }

    try {
      const delay = POOL_CONFIG.RETRY_DELAY * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      await pool.query(sql`SELECT 1`);
      this.metrics.isHealthy = true;
      logger.info('Database reconnection successful');
      return true;
    } catch (error) {
      logger.error(`Reconnection attempt ${attempt + 1} failed:`, error);
      return this.attemptReconnection(attempt + 1);
    }
  }

  // Health check implementation
  async startHealthChecks() {
    setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        // Log but don't throw - we don't want to crash the process
        logger.warn('Health check warning:', error);
      }
    }, POOL_CONFIG.HEALTH_CHECK_INTERVAL);
  }

  async performHealthCheck() {
    try {
      const stats = await getPoolStats();
      this.metrics = {
        ...this.metrics,
        lastHealthCheck: new Date(),
        isHealthy: stats.healthy,
        lastError: stats.lastError
      };

      if (!stats.healthy) {
        logger.warn('[Database] Service in degraded state:', {
          lastError: stats.lastError,
          lastCheck: stats.lastCheck
        });
      }
    } catch (error) {
      // Log but don't update metrics to avoid false negatives
      logger.warn('[Database] Health check warning:', error);
    }
  }

  async healthCheck() {
    try {
      const stats = await getPoolStats();
      const startTime = Date.now();
      
      // Quick query to test execution but don't block on failure
      const queryResult = await Promise.race([
        executeQuery(sql`SELECT 1`, [], { suppressError: true }),
        new Promise(resolve => setTimeout(() => resolve(null), 2000))
      ]);

      const responseTime = Date.now() - startTime;

      return {
        status: queryResult ? 'healthy' : 'degraded',
        responseTime,
        lastError: stats.lastError,
        lastCheck: stats.lastCheck,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      // Always return a response, never throw
      return {
        status: 'degraded',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async withRetry(operation, options = {}) {
    const { maxRetries, baseDelay } = { ...this.retryOptions, ...options };
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        // Don't retry if the error is not retryable
        if (!this.isRetryableError(error)) {
          throw error;
        }
        
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          logger.warn('[Database] Operation failed, retrying:', {
            attempt,
            maxRetries,
            delay,
            error: error.message
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  isRetryableError(error) {
    const retryableCodes = [
      '08000', // connection_exception
      '08003', // connection_does_not_exist
      '08006', // connection_failure
      '08001', // sqlclient_unable_to_establish_sqlconnection
      '08004', // sqlserver_rejected_establishment_of_sqlconnection
      '57P01', // admin_shutdown
      '57P02', // crash_shutdown
      '57P03', // cannot_connect_now
      'XX000'  // internal_error
    ];

    return retryableCodes.includes(error.code) || error.message.includes('Connection terminated');
  }
}

export const databaseService = new DatabaseService(); 
export default databaseService; 