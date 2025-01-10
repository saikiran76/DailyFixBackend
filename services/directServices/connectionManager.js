import {matrixWhatsAppService}  from '../matrixWhatsAppService.js';

class ConnectionManager {
  constructor() {
    this.connections = new Map();
  }

  async initializeConnection(userId, platform, credentials) {
    try {
      switch (platform) {
        case 'matrix-whatsapp':
          const result = await matrixWhatsAppService.initialize({ userId, credentials });
          this.connections.set(userId, {
            platform,
            status: 'active',
            timestamp: new Date().toISOString()
          });
          return result;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      console.error(`Error initializing ${platform} connection:`, error);
      throw error;
    }
  }

  async checkConnection(userId, platform) {
    try {
      switch (platform) {
        case 'matrix-whatsapp':
          return await matrixWhatsAppService.validateMatrixClient(userId);
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      console.error(`Error checking ${platform} connection:`, error);
      throw error;
    }
  }

  async disconnectPlatform(userId, platform) {
    try {
      switch (platform) {
        case 'matrix-whatsapp':
          // Matrix client cleanup is handled by the service
          this.connections.delete(userId);
          return { status: 'success' };
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      console.error(`Error disconnecting from ${platform}:`, error);
      throw error;
    }
  }

  getConnection(userId) {
    return this.connections.get(userId);
  }
}

export const connectionManager = new ConnectionManager(); 