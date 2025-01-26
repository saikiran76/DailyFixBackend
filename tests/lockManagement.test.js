const { DistributedLock } = require('../services/lockManager');
const { LockHealthMonitor } = require('../services/lockHealthMonitor');
const { LockCleanupService } = require('../services/lockCleanupService');
const Redis = require('ioredis');

describe('Lock Management Tests', () => {
  let redis;
  let lock;
  let healthMonitor;
  let cleanupService;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL);
    lock = new DistributedLock(redis);
    healthMonitor = new LockHealthMonitor(redis);
    cleanupService = new LockCleanupService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  describe('Lock Acquisition Tests', () => {
    test('should acquire lock successfully', async () => {
      const lockKey = 'test-lock-1';
      const acquired = await lock.acquire(lockKey, 30000);
      expect(acquired).toBeTruthy();
      expect(await redis.get(`lock:${lockKey}`)).toBeTruthy();
    });

    test('should fail to acquire already held lock', async () => {
      const lockKey = 'test-lock-2';
      await lock.acquire(lockKey, 30000);
      const secondAcquire = await lock.acquire(lockKey, 30000);
      expect(secondAcquire).toBeFalsy();
    });

    test('should acquire lock after timeout', async () => {
      const lockKey = 'test-lock-3';
      await lock.acquire(lockKey, 1000); // Short timeout
      await new Promise(resolve => setTimeout(resolve, 1100));
      const acquired = await lock.acquire(lockKey, 30000);
      expect(acquired).toBeTruthy();
    });
  });

  describe('Lock Release Tests', () => {
    test('should release lock successfully', async () => {
      const lockKey = 'test-lock-4';
      await lock.acquire(lockKey, 30000);
      await lock.release(lockKey);
      expect(await redis.get(`lock:${lockKey}`)).toBeFalsy();
    });

    test('should handle release of non-existent lock', async () => {
      const lockKey = 'non-existent-lock';
      await expect(lock.release(lockKey)).resolves.not.toThrow();
    });
  });

  describe('Lock Health Monitoring Tests', () => {
    test('should detect stale locks', async () => {
      const lockKey = 'stale-lock';
      await lock.acquire(lockKey, 1000);
      await new Promise(resolve => setTimeout(resolve, 1100));
      const staleLocksCount = await healthMonitor.checkStaleLocks();
      expect(staleLocksCount).toBeGreaterThan(0);
    });

    test('should track lock metrics', async () => {
      const lockKey = 'metric-test-lock';
      await lock.acquire(lockKey, 30000);
      const metrics = await healthMonitor.getLockMetrics();
      expect(metrics.activeLocks).toBeGreaterThan(0);
    });
  });

  describe('Lock Cleanup Tests', () => {
    test('should cleanup stale locks', async () => {
      const lockKey = 'cleanup-test-lock';
      await lock.acquire(lockKey, 1000);
      await new Promise(resolve => setTimeout(resolve, 1100));
      const cleanedCount = await cleanupService.cleanupStaleLocks();
      expect(cleanedCount).toBeGreaterThan(0);
      expect(await redis.get(`lock:${lockKey}`)).toBeFalsy();
    });
  });

  describe('Concurrent Access Tests', () => {
    test('should handle multiple concurrent lock attempts', async () => {
      const lockKey = 'concurrent-lock';
      const attempts = Array(5).fill().map(() => lock.acquire(lockKey, 30000));
      const results = await Promise.all(attempts);
      const successfulAcquires = results.filter(Boolean);
      expect(successfulAcquires.length).toBe(1);
    });
  });

  describe('Error Recovery Tests', () => {
    test('should recover from Redis connection failure', async () => {
      const lockKey = 'recovery-test-lock';
      await redis.disconnect();
      await redis.connect();
      const acquired = await lock.acquire(lockKey, 30000);
      expect(acquired).toBeTruthy();
    });
  });
}); 