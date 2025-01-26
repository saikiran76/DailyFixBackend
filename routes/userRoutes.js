import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

router.use(authenticateUser);

router.get('/onboarding-status', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Fetching onboarding status for user:', userId);
    
    let onboardingStatus = null;
    let accounts = [];
    
    try {
      // Get user's onboarding status from database
      const { data, error: statusError } = await adminClient
        .from('user_onboarding')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (!statusError || statusError.code === 'PGRST116') { // Not found is okay
        onboardingStatus = data;
      } else {
        console.warn('Error fetching onboarding status:', statusError);
      }

      // Get all accounts with their credentials
      const { data: accountsData, error: accountsError } = await adminClient
        .from('accounts')
        .select('platform, status, credentials')
        .eq('user_id', userId);

      if (!accountsError) {
        accounts = accountsData || [];
      } else {
        console.warn('Error fetching accounts:', accountsError);
      }
    } catch (dbError) {
      console.warn('Database operation failed:', dbError);
      // Continue with default values
    }

    // Check platform connections - use safe defaults if data is missing
    const matrixAccount = accounts.find(a => a.platform === 'matrix');
    const whatsappAccount = accounts.find(a => a.platform === 'whatsapp');

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
      .filter(account => {
        if (account.platform === 'whatsapp') {
          return account.status === 'active' && !!account.credentials?.bridge_room_id;
        }
        return account.status === 'active';
      })
      .map(account => account.platform);

    // Try to update onboarding status if needed
    if (matrixConnected && whatsappConnected && !onboardingStatus?.is_complete) {
      try {
        await adminClient
          .from('user_onboarding')
          .upsert({
            user_id: userId,
            current_step: 'complete',
            is_complete: true,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id'
          });
      } catch (updateError) {
        console.warn("Error updating onboarding status:", updateError);
        // Continue without failing the request
      }
    }

    const response = {
      isComplete: onboardingStatus?.is_complete || (matrixConnected && whatsappConnected),
      currentStep: (matrixConnected && whatsappConnected) ? 'complete' : (onboardingStatus?.current_step || 'welcome'),
      matrixConnected,
      whatsappConnected,
      connectedPlatforms,
      degraded: onboardingStatus === null // Indicate if we're working with incomplete data
    };

    console.log('Final onboarding status response:', response);
    res.json(response);
  } catch (error) {
    console.error('Error in onboarding status route:', error);
    // Return a degraded but valid response
    res.json({
      isComplete: false,
      currentStep: 'welcome',
      matrixConnected: false,
      whatsappConnected: false,
      connectedPlatforms: [],
      degraded: true,
      error: 'Service temporarily degraded'
    });
  }
});

// Update onboarding status
router.post('/onboarding-status', async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentStep, transactionId, previousStep, isRollback } = req.body;

    console.log('Updating onboarding status:', {
      userId,
      currentStep,
      transactionId,
      previousStep,
      isRollback
    });

    // Validate step transition
    const validSteps = ['welcome', 'protocol_selection', 'matrix_setup', 'whatsapp_setup', 'complete'];
    if (!validSteps.includes(currentStep)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid onboarding step'
      });
    }

    // Start database transaction
    const client = await adminClient.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current status first
      const { data: currentStatus, error: getError } = await client.query(
        'SELECT * FROM user_onboarding WHERE user_id = $1 FOR UPDATE',
        [userId]
      );

      if (getError && !getError.message.includes('not found')) {
        throw getError;
      }

      // For 'complete' step, verify required conditions are met
      if (currentStep === 'complete' && !isRollback) {
        // Check Matrix account
        const { data: matrixAccount, error: matrixError } = await client.query(
          'SELECT * FROM accounts WHERE user_id = $1 AND platform = $2',
          [userId, 'matrix']
        );

        if (matrixError) throw matrixError;

        // Check WhatsApp account
        const { data: whatsappAccount, error: whatsappError } = await client.query(
          'SELECT * FROM accounts WHERE user_id = $1 AND platform = $2',
          [userId, 'whatsapp']
        );

        if (whatsappError) throw whatsappError;

        // Verify both accounts exist and are active
        const matrixConnected = matrixAccount?.status === 'active';
        const whatsappConnected = whatsappAccount?.status === 'active' && 
                                 !!whatsappAccount?.credentials?.bridge_room_id;

        if (!matrixConnected || !whatsappConnected) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            message: 'Cannot complete onboarding: Matrix and WhatsApp must be connected'
          });
        }
      }

      // If this is a rollback, restore previous state
      if (isRollback) {
        const { error: rollbackError } = await client.query(
          'UPDATE user_onboarding SET current_step = $1, updated_at = NOW() WHERE user_id = $2',
          [previousStep, userId]
        );

        if (rollbackError) throw rollbackError;
      } else {
        // Store transaction ID to prevent duplicates
        if (transactionId) {
          try {
            await client.query(
              'INSERT INTO onboarding_transactions (transaction_id, user_id, from_step, to_step) VALUES ($1, $2, $3, $4)',
              [transactionId, userId, currentStatus?.current_step || 'initial', currentStep]
            );
          } catch (dupError) {
            if (dupError.code === '23505') { // Unique violation
              await client.query('ROLLBACK');
              return res.status(409).json({
                status: 'error',
                message: 'Transaction already processed'
              });
            }
            throw dupError;
          }
        }

        // Update or insert onboarding status
        const { error: updateError } = await client.query(
          `INSERT INTO user_onboarding (user_id, current_step, is_complete, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id) 
           DO UPDATE SET current_step = $2, is_complete = $3, updated_at = NOW()`,
          [userId, currentStep, currentStep === 'complete']
        );

        if (updateError) throw updateError;
      }

      // Commit transaction
      await client.query('COMMIT');

      // Get updated status
      const { data: updatedStatus, error: getUpdatedError } = await adminClient
        .from('user_onboarding')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (getUpdatedError) throw getUpdatedError;

      console.log('Onboarding status updated successfully:', {
        userId,
        currentStep,
        isComplete: currentStep === 'complete',
        isRollback
      });

      res.json({
        status: 'success',
        data: updatedStatus
      });

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

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