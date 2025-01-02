import { Client, GatewayIntentBits } from 'discord.js';

export const initializeDiscordClient = async () => {
  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('Missing DISCORD_BOT_TOKEN in environment variables');
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    await client.login(token);

    // Verify client connection
    client.on('ready', () => {
      console.log(`Discord bot logged in as ${client.user.tag}`);
    });

    return client;
  } catch (error) {
    console.error('Discord client initialization error:', error);
    throw error;
  }
};

// export const getDiscordClient = () => {
//   if (!discordClient) {
//     throw new Error('Discord client not initialized');
//   }
//   return discordClient;
// };