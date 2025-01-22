import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

// Local Redis configuration
const localConfig = {
  host: 'localhost',
  port: 6379
};

// Cloud Redis configuration
const cloudConfig = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  tls: process.env.REDIS_TLS === 'true' ? {
    rejectUnauthorized: true,
    requestCert: true
  } : undefined
};

async function testRedisConnection(config, name) {
  const client = createClient(config);
  
  client.on('error', (err) => {
    console.error(`${name} Redis Error:`, err);
  });

  try {
    await client.connect();
    console.log(`${name} Redis Connected`);
    
    // Test basic operations
    await client.set('test_key', 'Hello from ' + name);
    const value = await client.get('test_key');
    console.log(`${name} Redis Test Value:`, value);
    
    // Test pub/sub
    const subClient = client.duplicate();
    await subClient.connect();
    
    await subClient.subscribe('test_channel', (message) => {
      console.log(`${name} Redis Received Message:`, message);
    });
    
    await client.publish('test_channel', 'Test message from ' + name);
    
    // Cleanup
    await client.del('test_key');
    await subClient.unsubscribe('test_channel');
    await subClient.quit();
    await client.quit();
    
    console.log(`${name} Redis Test Completed Successfully`);
  } catch (error) {
    console.error(`${name} Redis Test Failed:`, error);
  }
}

// Test both connections
console.log('Starting Redis Tests...\n');

Promise.all([
  testRedisConnection(localConfig, 'Local'),
  testRedisConnection(cloudConfig, 'Cloud')
]).then(() => {
  console.log('\nAll Redis tests completed');
  process.exit(0);
}).catch((error) => {
  console.error('Tests failed:', error);
  process.exit(1);
}); 