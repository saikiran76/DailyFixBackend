import { WebClient } from '@slack/web-api';
import Account from '../models/Account.js';
import ChannelMapping from '../models/ChannelMapping.js';

// Platform-specific message sending functions
export async function sendPlatformMessage(platform, channelId, content) {
  switch (platform) {
    case 'slack':
      return await sendSlackMessageInternal(channelId, content);
    // Add other platforms here as needed
    default:
      console.warn(`Unsupported platform ${platform} for sending messages`);
      return null;
  }
}

// Internal function for sending Slack messages
async function sendSlackMessageInternal(channelId, content) {
  const mapping = await findSlackTokenForChannel(channelId);
  if (!mapping) {
    console.error(`No Slack token found for channel ${channelId}`);
    return;
  }
  const { token } = mapping;
  const client = new WebClient(token);
  try {
    await client.chat.postMessage({ channel: channelId, text: content });
    console.log(`Message sent on Slack to ${channelId}: ${content}`);
  } catch (err) {
    console.error('Slack send message error:', err);
  }
}

// Helper function to find Slack token for a channel
async function findSlackTokenForChannel(channelId) {
  const mapping = await ChannelMapping.findOne({ platform: 'slack', roomId: channelId }).lean();
  if (!mapping) {
    console.warn(`No channel mapping for Slack channel ${channelId}, creating default`);
    const slackAcc = await Account.findOne({ platform: 'slack' }).lean();
    if (!slackAcc) {
      console.error('No slack account found, cannot map user');
      return null;
    }
    await ChannelMapping.create({
      platform: 'slack',
      roomId: channelId,
      team_id: slackAcc.credentials.team_id,
      userId: slackAcc.userId
    });
    return {
      team_id: slackAcc.credentials.team_id,
      token: slackAcc.credentials.access_token
    };
  }

  const acc = await Account.findOne({ platform: 'slack', userId: mapping.userId }).lean();
  if (!acc || !acc.credentials.access_token) {
    console.error('Slack account not found for mapped user');
    return null;
  }
  return {
    team_id: acc.credentials.team_id,
    token: acc.credentials.access_token
  };
} 