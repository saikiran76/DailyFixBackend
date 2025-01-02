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

    // Get connected platforms
    const { data: accounts } = await adminClient
      .from('accounts')
      .select('platform')
      .eq('user_id', userId)
      .eq('status', 'active');

    const connectedPlatforms = accounts?.map(acc => acc.platform) || [];

    res.json({
      currentStep: data?.current_step || 'welcome',
      isComplete: data?.is_complete || false,
      connectedPlatforms
    });
  } catch (error) {
    console.error('Error fetching onboarding status:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding status' });
  }
});

// Update onboarding status
router.post('/update', async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentStep, isComplete } = req.body;

    const { error } = await adminClient
      .from('user_onboarding')
      .upsert({
        user_id: userId,
        current_step: currentStep,
        is_complete: isComplete,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating onboarding status:', error);
    res.status(500).json({ error: 'Failed to update onboarding status' });
  }
});

export default router; 