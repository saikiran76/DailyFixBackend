import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { supabase, adminClient } from '../utils/supabase.js';
import { matrixService } from '../services/matrixService.js';
import telegramService from '../services/telegramService.js';

const router = express.Router();
router.use(authenticateUser);

router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    // Fetch accounts directly from the accounts table
    const { data: accounts, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (error) throw error;

    res.json({ accounts });
  } catch (err) {
    console.error('Error fetching accounts:', err);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

router.get('/status', authenticateUser, async (req, res) => {
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

router.get('/inbox', authenticateUser, async (req, res) => {
  try {
    // First, verify user has active accounts
    const { data: accounts, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active');

    if (accountError) throw accountError;
    
    if (!accounts || accounts.length === 0) {
      return res.json({ messages: [] }); // Return empty messages if no accounts
    }

    // Get messages from all connected platforms
    const messages = [];
    for (const account of accounts) {
      try {
        switch (account.platform) {
          case 'matrix':
            console.log('Fetching Matrix messages for account:', account.id);
            const matrixMessages = await matrixService.getMatrixMessages(account);
            messages.push(...matrixMessages);
            break;
          case 'telegram':
            console.log('Fetching Telegram messages for account:', account.id);
            const telegramMessages = await telegramService.getTelegramMessages(account);
            messages.push(...telegramMessages);
            break;
          default:
            console.log(`Unsupported platform: ${account.platform}`);
        }
      } catch (platformError) {
        console.error(`Error fetching messages for ${account.platform}:`, platformError);
        // Continue with other platforms if one fails
      }
    }

    res.json({ 
      messages: messages.sort((a, b) => b.timestamp - a.timestamp),
      status: 'success'
    });
  } catch (error) {
    console.error('Error in /accounts/inbox:', error);
    res.status(500).json({ 
      error: 'Failed to fetch inbox messages',
      details: error.message 
    });
  }
});

// Get connected accounts
router.get('/connected', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const { data: accounts, error } = await adminClient
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (error) throw error;

    res.json(accounts);
  } catch (error) {
    console.error('Error fetching connected accounts:', error);
    res.status(500).json({ error: 'Failed to fetch connected accounts' });
  }
});

// Get messages for all connected platforms
router.get('/messages', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // First, verify user has active accounts
    const { data: accounts, error: accountError } = await adminClient
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (accountError) throw accountError;
    
    if (!accounts || accounts.length === 0) {
      return res.json({ messages: [] });
    }

    // Get messages from all connected platforms
    const messages = [];
    for (const account of accounts) {
      try {
        switch (account.platform) {
          case 'matrix':
            console.log('Fetching Matrix messages for account:', account.id);
            const matrixMessages = await matrixService.getMatrixMessages(account);
            messages.push(...matrixMessages);
            break;
          case 'telegram':
            console.log('Fetching Telegram messages for account:', account.id);
            const telegramMessages = await telegramService.getTelegramMessages(account);
            messages.push(...telegramMessages);
            break;
          case 'discord':
            console.log('Fetching Discord messages for account:', account.id);
            const { data: discordMessages, error: discordError } = await adminClient
              .from('messages')
              .select('*')
              .eq('platform', 'discord')
              .eq('user_id', userId)
              .order('timestamp', { ascending: false })
              .limit(50);
            if (!discordError && discordMessages) {
              messages.push(...discordMessages);
            }
            break;
          default:
            console.log(`Unsupported platform: ${account.platform}`);
        }
      } catch (platformError) {
        console.error(`Error fetching messages for ${account.platform}:`, platformError);
        // Continue with other platforms if one fails
      }
    }

    res.json({ 
      messages: messages.sort((a, b) => b.timestamp - a.timestamp),
      status: 'success'
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ 
      error: 'Failed to fetch messages',
      details: error.message 
    });
  }
});

export default router;
