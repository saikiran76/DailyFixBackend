import { initializeTelegram, finalizeTelegram, checkTelegramStatus, disconnectTelegram } from './telegramDirect.js';
import { initializeDiscord, finalizeDiscord, getDiscordStatus, disconnectDiscord } from './discordDirect.js';
import { initializeWhatsApp, finalizeWhatsApp, checkWhatsAppStatus, disconnectWhatsApp } from './whatsappDirect.js';

const platformHandlers = {
  telegram: {
    initialize: initializeTelegram,
    finalize: finalizeTelegram,
    checkStatus: checkTelegramStatus,
    disconnect: disconnectTelegram
  },
  discord: {
    initialize: initializeDiscord,
    finalize: finalizeDiscord,
    checkStatus: getDiscordStatus,
    disconnect: disconnectDiscord
  },
  whatsapp: {
    initialize: initializeWhatsApp,
    finalize: finalizeWhatsApp,
    checkStatus: checkWhatsAppStatus,
    disconnect: disconnectWhatsApp
  }
};

const activeConnections = new Map();

const clearConnection = (userId, platform) => {
  const key = `${userId}-${platform}`;
  if (activeConnections.has(key)) {
    console.log(`Clearing active connection for ${key}`);
    activeConnections.delete(key);
  }
};

// Platform requirements configuration
const platformRequirements = {
  telegram: {
    requiresToken: true,
    tokenType: 'bot',
    instructions: 'Get a bot token from @BotFather on Telegram'
  },
  discord: {
    requiresOAuth: true,
    permissions: ['bot', 'applications.commands'],
    scopes: ['bot', 'applications.commands']
  },
  whatsapp: {
    requiresQR: true,
    instructions: 'Scan the QR code with your WhatsApp mobile app'
  }
};

export const getPlatformRequirements = (platform) => {
  const requirements = platformRequirements[platform];
  if (!requirements) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return requirements;
};

export const initializePlatform = async (userId, platform, token = null) => {
  if (!platformHandlers[platform]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const handler = platformHandlers[platform];
  const key = `${userId}-${platform}`;

  try {
    // If token is provided, this is a finalization request
    if (token) {
      console.log(`Finalizing ${platform} connection for user ${userId}`);
      const result = await handler.finalize(userId, token);
      if (result.status === 'connected') {
        activeConnections.set(key, { status: 'connected', timestamp: Date.now() });
      }
      return result;
    }

    // This is an initialization request
    console.log(`Initializing ${platform} connection for user ${userId}`);
    const result = await handler.initialize(userId);
    activeConnections.set(key, { status: 'pending', timestamp: Date.now() });
    return result;

  } catch (error) {
    console.error(`Error in ${platform} connection:`, error);
    clearConnection(userId, platform);
    throw error;
  }
};

export const checkPlatformStatus = async (userId, platform) => {
  try {
    const handler = platformHandlers[platform];
    if (!handler) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Get platform-specific status check function
    const checkStatus = handler.checkStatus || (async () => ({ status: 'unknown' }));
    return await checkStatus(userId);
  } catch (error) {
    console.error(`Error checking ${platform} status:`, error);
    throw error;
  }
};

export const disconnectPlatform = async (userId, platform) => {
  try {
    const handler = platformHandlers[platform];
    if (!handler) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Get platform-specific disconnect function
    const disconnect = handler.disconnect || (async () => ({ status: 'disconnected' }));
    const result = await disconnect(userId);
    
    // Clear any active connection
    clearConnection(userId, platform);
    
    return result;
  } catch (error) {
    console.error(`Error disconnecting ${platform}:`, error);
    // Still try to clear connection on error
    clearConnection(userId, platform);
    throw error;
  }
}; 