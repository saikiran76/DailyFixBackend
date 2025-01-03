import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

router.use(authenticateUser);

// Update onboarding status (to match frontend's endpoint)
router.post('/onboarding-status', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Fetching onboarding status for user:', userId);
    const { currentStep } = req.body;

    console.log('Updating onboarding status:', {
      userId,
      currentStep
    });

    // First try to update existing record
    const { data: updateData, error: updateError } = await adminClient
      .from('user_onboarding')
      .update({
        current_step: currentStep,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select()
      .single();

    // If no record exists, insert a new one
    if (!updateData && !updateError) {
      const { data: insertData, error: insertError } = await adminClient
        .from('user_onboarding')
        .insert({
          user_id: userId,
          current_step: currentStep,
          is_complete: false
        })
        .select()
        .single();

      if (insertError) throw insertError;
      
      res.json({
        status: 'success',
        data: insertData
      });
      return;
    }

    if (updateError) throw updateError;

    res.json({
      status: 'success',
      data: updateData
    });
  } catch (error) {
    console.error('Error updating/inserting onboarding status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update onboarding status',
      error: error.message
    });
  }
});

// Get user profile
router.get('/profile', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const { data, error } = await adminClient
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;

    res.json({
      status: 'success',
      data
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch user profile'
    });
  }
});

export default router; 