import sdk from 'matrix-js-sdk';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';
import { handleWhatsAppBridge, handleTelegramBridge } from './platformBridgeHandlers.js';

class BridgeManager {
  constructor() {
    this.bridges = new Map();
    this.matrixClients = new Map();
  }

  async connectPlatform(userId, platform, credentials) {
    const matrixClient = this.matrixClients.get(userId);
    if (!matrixClient) {
      throw new Error('Matrix client not initialized');
    }

    // Create bridge room
    const bridgeRoom = await matrixClient.createRoom({
      visibility: 'private',
      invite: [BRIDGE_CONFIGS[platform].bridgeBot]
    });

    // Initialize platform-specific bridge
    let bridge;
    switch (platform) {
      case 'whatsapp':
        bridge = await this.initializeWhatsAppBridge(matrixClient, bridgeRoom.room_id, userId);
        break;
      case 'telegram':
        bridge = await this.initializeTelegramBridge(matrixClient, bridgeRoom.room_id, userId, credentials);
        break;
      case 'discord':
        bridge = await this.initializeDiscordBridge(matrixClient, bridgeRoom.room_id, userId, credentials);
        break;
      case 'slack':
        bridge = await this.initializeSlackBridge(matrixClient, bridgeRoom.room_id, userId, credentials);
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }

    this.bridges.set(`${userId}-${platform}`, bridge);
    return bridge;
  }

  async initializeMatrixClient(userId, credentials) {
    try {
      const matrixClient = sdk.createClient({
        baseUrl: credentials.homeserver,
        accessToken: credentials.accessToken,
        userId: credentials.userId
      });

      await matrixClient.startClient({ initialSyncLimit: 1 });
      this.matrixClients.set(userId, matrixClient);
      return matrixClient;
    } catch (error) {
      console.error('Matrix client initialization error:', error);
      throw new Error('Failed to initialize Matrix client');
    }
  }

  async initializeWhatsAppBridge(matrixClient, roomId, userId) {
    return handleWhatsAppBridge(matrixClient, userId);
  }

  async initializeTelegramBridge(matrixClient, roomId, userId, credentials) {
    return handleTelegramBridge(matrixClient, userId, credentials.botToken);
  }
}

export const bridgeManager = new BridgeManager(); 