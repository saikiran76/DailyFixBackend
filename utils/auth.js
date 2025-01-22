import { adminClient } from './supabase.js';
import logger from './logger.js';

export const verifyToken = async (token) => {
  try {
    const { data: { user }, error } = await adminClient.auth.getUser(token);
    
    if (error) {
      logger.error('Token verification failed:', error);
      return false;
    }

    return !!user;
  } catch (error) {
    logger.error('Token verification error:', error);
    return false;
  }
}; 