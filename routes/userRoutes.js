import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { supabase, adminClient } from '../utils/supabase.js';

const router = express.Router();
router.use(authMiddleware);

// Get user onboarding status
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

// Update user onboarding status
router.post('/onboarding-status', async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentStep } = req.body;

    console.log('Updating onboarding status:', { userId, currentStep });

    // First, check if a record exists
    const { data: existingRecord, error: checkError } = await adminClient
      .from('user_onboarding')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 means not found
      console.error('Error checking existing record:', checkError);
      throw checkError;
    }

    let result;
    if (existingRecord) {
      // Update existing record
      result = await adminClient
        .from('user_onboarding')
        .update({
          current_step: currentStep,
          is_complete: currentStep === 'completion',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);
    } else {
      // Insert new record
      result = await adminClient
        .from('user_onboarding')
        .insert({
          user_id: userId,
          current_step: currentStep,
          is_complete: currentStep === 'completion',
          updated_at: new Date().toISOString()
        });
    }

    if (result.error) {
      console.error('Error updating/inserting onboarding status:', result.error);
      throw result.error;
    }

    console.log('Successfully updated onboarding status');
    res.json({ 
      success: true,
      currentStep,
      isComplete: currentStep === 'completion'
    });
  } catch (error) {
    console.error('Error updating onboarding status:', error);
    res.status(500).json({ 
      error: 'Failed to update onboarding status',
      details: error.message 
    });
  }
});

export default router; 