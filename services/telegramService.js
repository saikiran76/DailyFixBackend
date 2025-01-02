import { adminClient as supabase } from '../utils/supabase.js';
import { Telegraf } from 'telegraf';

// Map to store Telegram clients
const telegramClients = new Map();

export async function initializeTelegramConnection(userId) {
  // Placeholder for Telegram initialization
  return {
    status: 'pending',
    requiresToken: true
  };
}

export async function finalizeTelegramConnection(userId, token) {
  try {
    // Validate token format
    if (!token || typeof token !== 'string') {
      throw new Error('Invalid token format');
    }

    // Test the token by creating a temporary bot
    try {
      const testBot = new Telegraf(token);
      const botInfo = await testBot.telegram.getMe();
      await testBot.telegram.deleteWebhook();
    } catch (botError) {
      throw new Error('Invalid Telegram bot token');
    }

    // Store in database
    const { error } = await supabase
      .from('accounts')
      .upsert({
        user_id: userId,
        platform: 'telegram',
        credentials: {
          token: token
        },
        status: 'active',
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,platform',
        returning: 'minimal'
      });

    if (error) throw error;

    return {
      status: 'connected',
      message: 'Telegram connected successfully'
    };
  } catch (error) {
    console.error('Telegram connection error:', error);
    throw error;
  }
}

export async function getTelegramMessages(account) {
  try {
    if (!account?.credentials?.token) {
      console.log('No credentials found for Telegram account');
      return [];
    }

    // For now, return empty array as we haven't implemented Telegram message fetching yet
    console.log('Telegram message fetching not implemented yet');
    return [];
  } catch (error) {
    console.error('Error fetching Telegram messages:', error);
    return [];
  }
}

export async function sendTelegramMessage(chatId, content, account) {
  try {
    if (!account?.credentials?.token) {
      throw new Error('No Telegram credentials found');
    }

    let bot = telegramClients.get(account.id);
    if (!bot) {
      bot = new Telegraf(account.credentials.token);
      telegramClients.set(account.id, bot);
    }

    await bot.telegram.sendMessage(chatId, content);
    console.log(`Message sent to Telegram chat ${chatId}`);
    return true;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    // Clean up the bot instance if there was an error
    telegramClients.delete(account.id);
    throw error;
  }
}

export async function initializeTelegramBotForUser(userId) {
  try {
    const { data: account, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'telegram')
      .eq('status', 'active')
      .single();

    if (error) throw error;
    if (!account) throw new Error('No active Telegram account found');

    // Initialize bot if not already initialized
    if (!telegramClients.has(account.id)) {
      const bot = new Telegraf(account.credentials.token);
      await bot.telegram.deleteWebhook(); // Clear any existing webhook
      telegramClients.set(account.id, bot);
    }

    return {
      status: 'initialized',
      botInfo: {
        username: account.credentials.username,
        token: '***' // Masked for security
      }
    };
  } catch (error) {
    console.error('Error initializing Telegram bot:', error);
    throw error;
  }
}

export default {
  initializeTelegramConnection,
  finalizeTelegramConnection,
  getTelegramMessages,
  initializeTelegramBotForUser,
  sendTelegramMessage
};
