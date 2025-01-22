import express from 'express';
import { adminClient } from '../utils/supabase.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// SIGNUP
router.post('/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    // Create user in Supabase
    const { data: { user }, error: signUpError } = await adminClient.auth.admin.createUser({
      email,
      password,
      user_metadata: {
        firstName,
        lastName
      }
    });

    if (signUpError) {
      if (signUpError.message.includes('already exists')) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      throw signUpError;
    }

    // Create session for the new user
    const { data: { session }, error: sessionError } = await adminClient.auth.admin.createSession({
      userId: user.id
    });

    if (sessionError) throw sessionError;

    res.status(201).json({
      token: session.access_token,
      user: {
        id: user.id,
        firstName: user.user_metadata.firstName,
        lastName: user.user_metadata.lastName,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Sign in with Supabase
    const { data: { session }, error: signInError } = await adminClient.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { user } = session;

    res.json({
      token: session.access_token,
      user: {
        id: user.id,
        firstName: user.user_metadata.firstName,
        lastName: user.user_metadata.lastName,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// VERIFY TOKEN
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const { data: { user }, error } = await adminClient.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({
      user: {
        id: user.id,
        firstName: user.user_metadata.firstName,
        lastName: user.user_metadata.lastName,
        email: user.email
      }
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// GET SESSION
router.get('/session', authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: 'No active session' });
    }

    // Get the token from the request header
    const token = req.headers.authorization?.split(' ')[1];

    res.json({
      token,
      userId: user.id,
      email: user.email,
      firstName: user.user_metadata.firstName,
      lastName: user.user_metadata.lastName,
      lastActivity: new Date().toISOString()
    });
  } catch (error) {
    console.error('Session fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch session information' });
  }
});

export default router;
