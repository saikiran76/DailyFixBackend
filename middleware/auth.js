import supabase from '../utils/supabase.js';

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
    
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (error) {
        console.error('Token validation error:', error);
        return res.status(401).json({ 
          status: 'error',
          message: 'Invalid or expired token',
          code: 'TOKEN_INVALID'
        });
      }

      if (!user) {
        console.error('No user found for token');
        return res.status(401).json({ 
          status: 'error',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        });
      }

      // Add user info to request
      req.user = {
        id: user.id,
        email: user.email,
        ...user.user_metadata
      };

      // Log successful auth
      console.log('Authenticated user:', {
        id: req.user.id,
        email: req.user.email,
        path: req.path,
        method: req.method
      });

      next();
    } catch (tokenError) {
      console.error('Token validation failed:', tokenError);
      return res.status(401).json({ 
        status: 'error',
        message: 'Token validation failed',
        code: 'TOKEN_VALIDATION_FAILED'
      });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Authentication service unavailable',
      code: 'AUTH_SERVICE_ERROR'
    });
  }
};

export default authenticateUser; 