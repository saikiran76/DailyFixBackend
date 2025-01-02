import express from 'express';
import { bridgeManager } from '../services/bridgeManager.js';
import authMiddleware from '../middleware/authMiddleware.js';
import supabase from '../utils/supabase.js';
import { initializePlatformBridge } from '../services/matrixBridgeService.js';

const router = express.Router();

router.post('/initialize', authMiddleware, async (req, res) => {
  const { userId, platform } = req.body;

  try {
    // Get Matrix credentials from Supabase
    const { data: account, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'matrix')
      .eq('status', 'active')
      .single();

    if (error || !account) {
      throw new Error('Matrix account not found');
    }

    // Initialize Matrix client
    await bridgeManager.initializeMatrixClient(userId, account.credentials);
    
    res.json({ status: 'initialized' });
  } catch (error) {
    console.error('Bridge initialization error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:platform/connect', authMiddleware, async (req, res) => {
  const { platform } = req.params;
  const { userId } = req.body;

  try {
    // First ensure Matrix client is initialized
    const { data: matrixAccount, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'matrix')
      .eq('status', 'active')
      .single();

    if (error || !matrixAccount) {
      throw new Error('Matrix account required for bridge connection');
    }

    // Initialize Matrix client if not already initialized
    await bridgeManager.initializeMatrixClient(userId, matrixAccount.credentials);

    // Initialize the bridge connection
    const result = await initializePlatformBridge(userId, platform);

    if (platform === 'whatsapp') {
      res.json({ 
        status: 'pending',
        message: 'WhatsApp bridge initialized, waiting for QR code',
        bridgeRoomId: result.bridgeRoomId
      });
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error(`${platform} bridge connection error:`, error);
    res.status(500).json({ 
      error: error.message || `Failed to connect ${platform} bridge`
    });
  }
});

export default router; 