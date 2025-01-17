import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateUser);

// Get onboarding status
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const { data, error } = await adminClient
      .from('user_onboarding')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) throw error;

    res.json({
      status: 'success',
      data: data || { current_step: 'initial', is_complete: false }
    });
  } catch (error) {
    console.error('Error fetching onboarding status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch onboarding status'
    });
  }
});

// Update onboarding status
router.post('/status', async (req, res) => {
  try {
    const userId = req.user.id;
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
    console.error('Error updating onboarding status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update onboarding status'
    });
  }
});

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