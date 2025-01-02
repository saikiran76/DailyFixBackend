import sdk from 'matrix-js-sdk';
import { ioEmitter } from '../utils/emitter.js';
import supabase from '../utils/supabase.js';
import { handleWhatsAppBridge, handleTelegramBridge } from './platformBridgeHandlers.js';
import { initializeBridgeConnection } from './platformBridgeInitializer.js';

export const bridges = new Map();

export async function initializePlatformBridge(userId, platform, credentials) {
  try {
    // Get Matrix account
    const { data: account, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'matrix')
      .eq('status', 'active')
      .single();

    if (error || !account) {
      throw new Error('No active Matrix account found');
    }

    const matrixClient = sdk.createClient({
      baseUrl: account.credentials.homeserver,
      accessToken: account.credentials.accessToken,
      userId: account.credentials.userId
    });

    await matrixClient.startClient({ initialSyncLimit: 1 });

    const bridge = {
      matrixClient,
      platform,
      userId
    };

    bridges.set(`${userId}-${platform}`, bridge);

    switch (platform) {
      case 'whatsapp':
        return await handleWhatsAppBridge(matrixClient, userId);
      case 'telegram':
        return await handleTelegramBridge(matrixClient, userId, credentials.botToken);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    console.error(`Failed to initialize ${platform} bridge:`, error);
    throw error;
  }
} 