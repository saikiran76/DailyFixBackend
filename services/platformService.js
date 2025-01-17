import { matrixWhatsAppService } from './matrixWhatsAppService.js';

export const initializePlatform = async (userId, platform, credentials) => {
  try {
    switch (platform) {
      case 'matrix-whatsapp':
        return await matrixWhatsAppService.initialize({ userId, credentials });
      // Add other platforms here
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    console.error(`Error initializing platform ${platform}:`, error);
    throw error;
  }
};

export const connectPlatform = async (userId, platform) => {
  try {
    switch (platform) {
      case 'matrix-whatsapp':
        return await matrixWhatsAppService.connectWhatsApp(userId);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    console.error(`Error connecting to platform ${platform}:`, error);
    throw error;
  }
};

export const disconnectPlatform = async (userId, platform) => {
  try {
    switch (platform) {
      case 'matrix-whatsapp':
        // Matrix client cleanup will be handled by the service
        return { status: 'success' };
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    console.error(`Error disconnecting from platform ${platform}:`, error);
    throw error;
  }
};

export const checkPlatformStatus = async (userId, platform) => {
  try {
    switch (platform) {
      case 'matrix-whatsapp':
        return await matrixWhatsAppService.validateMatrixClient(userId);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    console.error(`Error checking platform ${platform} status:`, error);
    throw error;
  }
}; 