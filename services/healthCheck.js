import supabase from '../utils/supabase.js';
import { bridges } from './matrixBridgeService.js';

export async function checkSystemHealth() {
  const health = {
    database: false,
    bridges: {},
    timestamp: new Date().toISOString()
  };

  // Check database connection
  try {
    const { data, error } = await supabase.from('accounts').select('count').limit(1);
    health.database = !error;
  } catch (error) {
    console.error('Database health check failed:', error);
  }

  // Check bridge connections
  for (const [key, bridge] of bridges.entries()) {
    try {
      const [userId, platform] = key.split('-');
      const synced = await bridge.matrixClient.syncLeftRooms();
      health.bridges[key] = {
        connected: synced,
        lastActivity: new Date().toISOString()
      };
    } catch (error) {
      console.error(`Bridge health check failed for ${key}:`, error);
      health.bridges[key] = { connected: false, error: error.message };
    }
  }

  return health;
} 