import { supabase } from '../utils/supabase.js';

export default async function authMiddleware(req, res, next) {
  try {
    console.log('Auth middleware - Request path:', req.path);
    
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      console.log('No token provided in request');
      return res.status(401).json({ error: 'No token provided' });
    }

    console.log('Validating token...');
    
    // Verify the token using admin client
    const { data: { user }, error: adminError } = await supabase.auth.getUser(token);
    
    if (adminError || !user) {
      console.error('Token validation error:', adminError);
      return res.status(401).json({ error: 'Invalid token', details: adminError?.message });
    }

    console.log('User authenticated:', user.id);
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed', details: error.message });
  }
} 