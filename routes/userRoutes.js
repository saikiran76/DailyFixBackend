import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

router.use(authenticateUser);

router.get('/onboarding-status', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Fetching onboarding status for user:', userId);
    
    // Get user's onboarding status from database
    const { data: onboardingStatus, error: statusError } = await adminClient
      .from('user_onboarding')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (statusError && statusError.code !== 'PGRST116') { // Not found is okay
      console.error('Error fetching onboarding status:', statusError);
      throw statusError;
    }

    // Get connected platforms
    const { data: platforms, error: platformsError } = await adminClient
      .from('accounts')
      .select('platform, status')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (platformsError) {
      console.error('Error fetching platforms:', platformsError);
      throw platformsError;
    }

    const response = {
      isComplete: onboardingStatus?.is_complete || false,
      currentStep: onboardingStatus?.current_step || 'welcome',
      matrixConnected: platforms?.some(p => p.platform === 'matrix') || false,
      connectedPlatforms: platforms?.map(p => p.platform) || []
    };

    console.log('Onboarding status response:', response);
    res.json(response);
  } catch (error) {
    console.error('Error in onboarding status route:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding status' });
  }
});

// Update onboarding status (to match frontend's endpoint)
router.post('/onboarding-status', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Updating onboarding status for user:', userId);
    const { currentStep } = req.body;

    // Validate step transition
    const validSteps = ['welcome', 'protocol_selection', 'matrix_setup', 'whatsapp_setup', 'complete'];
    if (!validSteps.includes(currentStep)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid onboarding step'
      });
    }

    // Update or insert onboarding status
    const { data: updateData, error: updateError } = await adminClient
      .from('user_onboarding')
      .upsert({
        user_id: userId,
        current_step: currentStep,
        is_complete: currentStep === 'complete',
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id',
        returning: 'minimal'
      });

    if (updateError) {
      console.error('Error updating onboarding status:', updateError);
      throw updateError;
    }

    // Get updated status
    const { data: currentStatus, error: getError } = await adminClient
      .from('user_onboarding')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (getError) {
      console.error('Error fetching updated status:', getError);
      throw getError;
    }

    console.log('Onboarding status updated successfully:', {
      userId,
      currentStep,
      isComplete: currentStep === 'complete'
    });

    res.json({
      status: 'success',
      data: currentStatus
    });
  } catch (error) {
    console.error('Error in onboarding status update:', error);
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