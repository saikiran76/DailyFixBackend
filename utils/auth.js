import jwt from 'jsonwebtoken';
import { adminClient } from './supabase.js';

export const verifyToken = async (token) => {
  try {
    // Verify the JWT token using the Supabase JWT secret
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);

    // Get user from Supabase to ensure they still exist and are valid
    const { data: user, error } = await adminClient
      .from('users')
      .select('id, email')
      .eq('id', decoded.sub)
      .single();

    if (error || !user) {
      console.error('User verification failed:', error || 'User not found');
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      ...decoded
    };
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}; 