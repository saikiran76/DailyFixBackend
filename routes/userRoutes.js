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
    
    console.log("Current onboarding status:", onboardingStatus);
    if (statusError && statusError.code !== 'PGRST116') { // Not found is okay
      console.error('Error fetching onboarding status:', statusError);
      throw statusError;
    }

    // Get all accounts with their credentials
    const { data: accounts, error: accountsError } = await adminClient
      .from('accounts')
      .select('platform, status, credentials')
      .eq('user_id', userId);

    if (accountsError) {
      console.error('Error fetching accounts:', accountsError);
      throw accountsError;
    }

    console.log("Found accounts:", accounts);

    // Check platform connections
    const matrixAccount = accounts?.find(a => a.platform === 'matrix');
    const whatsappAccount = accounts?.find(a => a.platform === 'whatsapp');

    console.log("Matrix account:", matrixAccount);
    console.log("WhatsApp account:", whatsappAccount);

    const matrixConnected = matrixAccount?.status === 'active';
    const whatsappConnected = whatsappAccount?.status === 'active' && 
                             !!whatsappAccount?.credentials?.bridge_room_id;

    console.log("Connection status:", {
      matrixConnected,
      whatsappConnected,
      matrixStatus: matrixAccount?.status,
      whatsappStatus: whatsappAccount?.status,
      bridgeRoomId: whatsappAccount?.credentials?.bridge_room_id
    });

    // Get connected platforms
    const connectedPlatforms = accounts
      ?.filter(account => {
        if (account.platform === 'whatsapp') {
          return account.status === 'active' && !!account.credentials?.bridge_room_id;
        }
        return account.status === 'active';
      })
      .map(account => account.platform) || [];

    console.log("Connected platforms:", connectedPlatforms);

    // If both are connected but onboarding isn't complete, update it
    if (matrixConnected && whatsappConnected && !onboardingStatus?.is_complete) {
      console.log("Both platforms connected but onboarding not complete. Updating status...");
      const { data: updateData, error: updateError } = await adminClient
        .from('user_onboarding')
        .upsert({
          user_id: userId,
          current_step: 'complete',
          is_complete: true,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        });

      if (updateError) {
        console.error("Error updating onboarding status:", updateError);
      } else {
        console.log("Successfully updated onboarding status:", updateData);
      }
    }

    const response = {
      isComplete: onboardingStatus?.is_complete || (matrixConnected && whatsappConnected),
      currentStep: (matrixConnected && whatsappConnected) ? 'complete' : (onboardingStatus?.current_step || 'welcome'),
      matrixConnected,
      whatsappConnected,
      connectedPlatforms
    };

    console.log('Final onboarding status response:', response);
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

    // Get current status first
    const { data: currentStatus, error: getError } = await adminClient
      .from('user_onboarding')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (getError && !getError.message.includes('not found')) {
      console.error('Error fetching current status:', getError);
      throw getError;
    }

    // For 'complete' step, verify required conditions are met
    if (currentStep === 'complete') {
      // Check Matrix account
      const { data: matrixAccount, error: matrixError } = await adminClient
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (matrixError && !matrixError.message.includes('not found')) {
        throw matrixError;
      }

      // Check WhatsApp account
      const { data: whatsappAccount, error: whatsappError } = await adminClient
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', 'whatsapp')
        .single();

      if (whatsappError && !whatsappError.message.includes('not found')) {
        throw whatsappError;
      }

      // Verify both accounts exist and are active
      const matrixConnected = matrixAccount?.status === 'active';
      const whatsappConnected = whatsappAccount?.status === 'active' && 
                               !!whatsappAccount?.credentials?.bridge_room_id;

      if (!matrixConnected || !whatsappConnected) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot complete onboarding: Matrix and WhatsApp must be connected'
        });
      }
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
    const { data: updatedStatus, error: getUpdatedError } = await adminClient
      .from('user_onboarding')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (getUpdatedError) {
      console.error('Error fetching updated status:', getUpdatedError);
      throw getUpdatedError;
    }

    console.log('Onboarding status updated successfully:', {
      userId,
      currentStep,
      isComplete: currentStep === 'complete'
    });

    res.json({
      status: 'success',
      data: updatedStatus
    });
  } catch (error) {
    console.error('Error in onboarding status update:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to update onboarding status',
      details: error.details || error.toString()
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