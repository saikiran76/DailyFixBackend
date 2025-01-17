import { Client, GatewayIntentBits } from 'discord.js';
import { supabase } from '../utils/supabase.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.login(process.env.DISCORD_BOT_TOKEN);

export const getChannelMessages = async (channelId) => {
  try {
    // Wait for client to be ready
    if (!client.isReady()) {
      await new Promise(resolve => client.once('ready', resolve));
    }

    // Get today's start and end timestamps
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Fetch channel using bot token
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    // Fetch messages with bot token
    const messages = await channel.messages.fetch({ limit: 100 });
    
    // Filter messages for today and transform to needed format
    const todayMessages = Array.from(messages.values())
      .filter(msg => {
        const msgDate = new Date(msg.createdTimestamp);
        return msgDate >= today && msgDate < tomorrow;
      })
      .map(msg => ({
        id: msg.id,
        content: msg.content,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          bot: msg.author.bot
        },
        timestamp: msg.createdAt.toISOString(),
        attachments: Array.from(msg.attachments.values()),
        mentions: {
          users: Array.from(msg.mentions.users.values()),
          roles: Array.from(msg.mentions.roles.values())
        }
      }));

    return todayMessages;
  } catch (error) {
    console.error('Error fetching channel messages:', error);
    throw new Error('Failed to fetch channel messages: ' + error.message);
  }
};

// Add event handlers for real-time updates
client.on('ready', () => {
  console.log('Discord bot is ready!');
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});