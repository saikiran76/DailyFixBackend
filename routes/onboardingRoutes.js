import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateUser);

// Note: Onboarding status management has been moved to userRoutes.js
// to maintain consistency with frontend service calls.
// See /user/onboarding-status GET and POST endpoints.

// Complete onboarding
router.post('/complete', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await adminClient
      .from('user_onboarding')
      .update({
        is_complete: true,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      status: 'success',
      data
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to complete onboarding'
    });
  }
});

export default router; 