import express from 'express';
import { databaseService } from '../services/databaseService.js';
import { lockService } from '../services/lockService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Database health check endpoint
router.get('/health/db', async (req, res) => {
  try {
    const health = await databaseService.healthCheck();
    
    if (health.status === 'healthy') {
      res.status(200).json(health);
    } else {
      res.status(503).json(health);
    }
  } catch (error) {
    logger.error('[Health Check] Database check failed:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Lock service health check endpoint
router.get('/health/locks', async (req, res) => {
  try {
    const metrics = lockService.getMetrics();
    const activeLocks = Array.from(lockService.activeLocks.entries()).map(([key, info]) => ({
      resource: info.resource,
      acquiredAt: info.acquiredAt,
      ttl: info.ttl,
      age: Date.now() - info.acquiredAt
    }));

    const status = {
      metrics,
      activeLocks,
      contentionRate: calculateContentionRate(metrics),
      timestamp: new Date().toISOString()
    };

    // Check for high contention
    if (status.contentionRate > 0.5) { // More than 50% contention
      logger.warn('[Lock Service] High lock contention detected:', {
        contentionRate: status.contentionRate,
        timestamp: status.timestamp
      });
    }

    res.status(200).json(status);
  } catch (error) {
    logger.error('[Health Check] Lock service check failed:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to calculate contention rate
function calculateContentionRate(metrics) {
  const attempts = metrics.lock_acquisition_attempt || 0;
  const failures = metrics.lock_acquisition_failure || 0;
  return attempts > 0 ? failures / attempts : 0;
}

// Detailed database stats endpoint (protected)
router.get('/health/db/stats', async (req, res) => {
  try {
    const stats = await databaseService.getDetailedStats();
    res.status(200).json({
      status: 'success',
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('[Health Check] Failed to get database stats:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router; 