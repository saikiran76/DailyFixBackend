import Redis from 'ioredis';

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  showFriendlyErrorStack: true
});

redis.on('connect', () => {
  console.log('Connected to Redis');
  redis.set('test', 'Hello Redis', (err, result) => {
    if (err) {
      console.error('Error setting value:', err);
    } else {
      console.log('Set result:', result);
      redis.get('test', (err, result) => {
        if (err) {
          console.error('Error getting value:', err);
        } else {
          console.log('Get result:', result);
        }
        redis.quit();
      });
    }
  });
});

redis.on('error', (err) => {
  console.error('Redis Error:', err);
}); 