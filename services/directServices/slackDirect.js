import { WebClient } from '@slack/web-api';
import { adminClient } from '../../utils/supabase.js';
import { ioEmitter } from '../../utils/emitter.js';

const sessions = new Map();

// Helper function to emit status updates
const emitSlackStatus = (userId, status, data = {}) => {
  ioEmitter.emit('slack_status', {
    userId,
    status,
    ...data
  });
};

// Initialize Slack connection
export const initializeSlack = async (userId, token) => {
  try {
    console.log('Initializing Slack connection for user:', userId);

    if (!token) {
      throw new Error('Slack bot token is required');
    }

    // Create Slack client
    const client = new WebClient(token);
    sessions.set(userId, client);

    // Test the connection and get bot info
    const auth = await client.auth.test();
    const botInfo = await client.users.info({
      user: auth.user_id
    });

    console.log('Slack bot info:', botInfo);

    // Update database
    await adminClient
      .from('accounts')
      .upsert({
        user_id: userId,
        platform: 'slack',
        status: 'active',
        credentials: {
          botId: auth.user_id,
          botName: botInfo.user.name,
          teamId: auth.team_id,
          teamName: auth.team,
          token: token // Store encrypted in production
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    emitSlackStatus(userId, 'connected', {
      botInfo: {
        id: auth.user_id,
        name: botInfo.user.name,
        team: auth.team
      }
    });

    return {
      status: 'connected',
      botInfo: {
        id: auth.user_id,
        name: botInfo.user.name,
        team: auth.team
      }
    };

  } catch (error) {
    console.error('Error initializing Slack:', error);
    emitSlackStatus(userId, 'error', { error: error.message });
    throw error;
  }
};

// Check Slack connection status
export const checkSlackStatus = async (userId) => {
  try {
    const client = sessions.get(userId);
    if (!client) {
      return { status: 'disconnected' };
    }

    const { data: account } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'slack')
      .single();

    return {
      status: account?.status || 'disconnected',
      botInfo: account?.credentials
    };
  } catch (error) {
    console.error('Error checking Slack status:', error);
    throw error;
  }
};

// Disconnect Slack
export const disconnectSlack = async (userId) => {
  try {
    sessions.delete(userId);

    // Update database
    await adminClient
      .from('accounts')
      .delete()
      .eq('user_id', userId)
      .eq('platform', 'slack');

    return { status: 'disconnected' };
  } catch (error) {
    console.error('Error disconnecting Slack:', error);
    throw error;
  }
};

// Send Slack message
export const sendSlackMessage = async (userId, channel, message) => {
  try {
    const client = sessions.get(userId);
    if (!client) {
      throw new Error('Slack not connected');
    }

    const result = await client.chat.postMessage({
      channel,
      text: message
    });

    return {
      messageId: result.ts,
      timestamp: new Date(result.ts * 1000).toISOString()
    };
  } catch (error) {
    console.error('Error sending Slack message:', error);
    throw error;
  }
}; 