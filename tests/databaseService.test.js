import { databaseService } from '../services/databaseService.js';
import logger from '../services/logger.js';

// Mock logger to prevent console noise during tests
jest.mock('../services/logger.js', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

describe('Database Service Tests', () => {
  beforeAll(async () => {
    // Ensure database is initialized
    await databaseService.pool.query('SELECT 1');
  });

  afterAll(async () => {
    await databaseService.cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Connection Pool Tests', () => {
    test('should maintain connection pool within limits', async () => {
      const connections = [];
      try {
        // Acquire multiple connections up to max pool size
        for (let i = 0; i < 20; i++) {
          const client = await databaseService.pool.connect();
          connections.push(client);
        }

        const poolStatus = await databaseService.getPoolStatus();
        expect(poolStatus.totalConnections).toBeLessThanOrEqual(20);
        expect(poolStatus.idleConnections).toBe(0);
      } finally {
        // Release all connections
        await Promise.all(connections.map(client => client.release()));
      }
    });

    test('should handle connection timeouts', async () => {
      const slowQuery = 'SELECT pg_sleep(2)';
      await expect(
        databaseService.executeQuery(slowQuery, [], 0)
      ).resolves.not.toThrow();
    });
  });

  describe('Health Check Tests', () => {
    test('should perform health check successfully', async () => {
      await databaseService.performHealthCheck();
      expect(databaseService.metrics.isHealthy).toBe(true);
      expect(databaseService.metrics.lastHealthCheck).toBeInstanceOf(Date);
    });

    test('should track connection metrics', async () => {
      const metrics = await databaseService.getPoolStatus();
      expect(metrics).toHaveProperty('totalConnections');
      expect(metrics).toHaveProperty('idleConnections');
      expect(metrics).toHaveProperty('waitingClients');
      expect(metrics).toHaveProperty('errorCount');
    });
  });

  describe('Error Handling Tests', () => {
    test('should handle invalid queries gracefully', async () => {
      const invalidQuery = 'SELECT * FROM nonexistent_table';
      await expect(
        databaseService.executeQuery(invalidQuery)
      ).rejects.toThrow();
    });

    test('should retry failed queries', async () => {
      // Mock a failing query that succeeds on retry
      const failingQuery = 'SELECT 1';
      let attempts = 0;
      
      jest.spyOn(databaseService.pool, 'connect').mockImplementation(() => {
        attempts++;
        if (attempts === 1) {
          throw new Error('ECONNRESET');
        }
        return databaseService.pool.connect();
      });

      await expect(
        databaseService.executeQuery(failingQuery)
      ).resolves.not.toThrow();

      expect(attempts).toBe(2);
    });
  });

  describe('Cleanup Tests', () => {
    test('should cleanup resources properly', async () => {
      const tempPool = databaseService.pool;
      await databaseService.cleanup();
      expect(tempPool.totalCount).toBe(0);
    });
  });

  describe('Connection Recovery Tests', () => {
    test('should recover from connection failures', async () => {
      // Simulate a connection failure
      await databaseService.pool.end();
      
      // Attempt a query which should trigger reconnection
      const query = 'SELECT 1';
      await expect(
        databaseService.executeQuery(query)
      ).resolves.not.toThrow();
    });
  });
}); 