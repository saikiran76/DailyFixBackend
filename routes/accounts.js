import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { supabase } from '../utils/supabase.js';

const router = express.Router();

router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('accounts')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('status', 'active')
      .limit(1);

    if (error) throw error;

    res.json({
      hasAccounts: accounts && accounts.length > 0
    });
  } catch (error) {
    console.error('Account status check error:', error);
    res.status(500).json({ error: 'Failed to check account status' });
  }
});

export default router; 