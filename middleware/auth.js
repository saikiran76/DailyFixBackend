import { supabase } from '../utils/supabase.js';
import jwt from 'jsonwebtoken';

export const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      console.warn('No token provided in request');
      return res.status(401).json({ 
        status: 'error',
        message: 'Authentication required' 
      });
    }

    const token = authHeader.split(' ')[1];
    console.log('Attempting authentication with token');
    
    // First try Supabase authentication
    try {
      const { data: { user }, error: supabaseError } = await supabase.auth.getUser(token);
      
      if (!supabaseError && user) {
        console.log('Supabase authentication successful for user:', user.id);
        req.user = {
          id: user.id,
          email: user.email,
          ...user.user_metadata
        };
        return next();
      } else {
        console.log('Supabase authentication failed, trying JWT');
      }
    } catch (supabaseError) {
      console.log('Supabase auth error:', supabaseError.message);
    }

    // If Supabase fails, try JWT
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('JWT authentication successful for user:', decoded.id);
      req.user = {
        id: decoded.id,
        email: decoded.email
      };
      return next();
    } catch (jwtError) {
      console.error('JWT verification failed:', jwtError.message);
      return res.status(401).json({ 
        status: 'error',
        message: 'Invalid or expired token',
        code: 'TOKEN_INVALID'
      });
    }
  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(401).json({ 
      status: 'error',
      message: 'Authentication failed',
      code: 'AUTH_FAILED'
    });
  }
};

export default authenticateUser; 