import sdk from 'matrix-js-sdk';
import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
import { supabase } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';
import { logger } from '../utils/logger.js';

const BRIDGE_STATES = {
  INITIALIZING: 'initializing',
  WAITING_FOR_QR: 'waiting_for_qr',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error'
};

async function createBridgeRoom(matrixClient, platform) {
  try {
    const room = await matrixClient.createRoom({
      visibility: 'private',
      invite: [BRIDGE_CONFIGS[platform].bridgeBot]
    });

    logger.info(`Created bridge room for ${platform}: ${room.room_id}`);

    // Wait for bridge bot to join with timeout
    const botJoined = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), BRIDGE_TIMEOUTS.botJoin);
      
      const handleMembership = (event, member) => {
        if (member.roomId === room.room_id && 
            member.userId === BRIDGE_CONFIGS[platform].bridgeBot && 
            member.membership === 'join') {
          clearTimeout(timeout);
          matrixClient.removeListener('RoomMember.membership', handleMembership);
          resolve(true);
        }
      };
      
      matrixClient.on('RoomMember.membership', handleMembership);
    });

    if (!botJoined) {
      throw new Error(`${platform} bridge bot failed to join room`);
    }

    return room;
  } catch (error) {
    logger.error(`Failed to create bridge room for ${platform}:`, error);
    throw error;
  }
}

export async function handleWhatsAppBridge(matrixClient, userId) {
  let bridgeState = BRIDGE_STATES.INITIALIZING;
  let retryCount = 0;
  const MAX_RETRIES = 3;

  const updateBridgeState = async (state, error = null) => {
    bridgeState = state;
    await supabase
      .from('bridge_states')
      .upsert({ 
        user_id: userId,
        platform: 'whatsapp',
        state,
        error: error?.message,
        updated_at: new Date().toISOString()
      });
    
    ioEmitter.emit('bridge:state_change', {
      userId,
      platform: 'whatsapp',
      state,
      error: error?.message
    });
  };

  try {
    await updateBridgeState(BRIDGE_STATES.INITIALIZING);
    const bridgeRoom = await createBridgeRoom(matrixClient, 'whatsapp');
    
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        matrixClient.removeListener('Room.timeline', handleResponse);
      };

      const timeout = setTimeout(async () => {
        cleanup();
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          logger.warn(`WhatsApp bridge timeout, retrying (${retryCount}/${MAX_RETRIES})`);
          await updateBridgeState(BRIDGE_STATES.DISCONNECTED);
          resolve(handleWhatsAppBridge(matrixClient, userId));
        } else {
          const error = new Error('WhatsApp bridge timeout after max retries');
          await updateBridgeState(BRIDGE_STATES.ERROR, error);
          reject(error);
        }
      }, BRIDGE_TIMEOUTS.whatsapp);

      const handleResponse = async (event, room) => {
        if (room.roomId !== bridgeRoom.room_id) return;
        if (event.getType() !== 'm.room.message') return;

        const content = event.getContent().body;
        logger.debug('Bridge response:', content);

        // Check for QR code or connection status in response
        if (content.includes('Scan this QR code')) {
          await updateBridgeState(BRIDGE_STATES.WAITING_FOR_QR);
          // Extract and emit QR code
          const qrCode = content.match(/```([\s\S]+?)```/)?.[1];
          if (qrCode) {
            ioEmitter.emit('whatsapp:qr_code', { userId, qrCode });
          }
        } else if (content.includes('WhatsApp connection successful')) {
          cleanup();
          await updateBridgeState(BRIDGE_STATES.CONNECTED);
          resolve(true);
        } else if (content.includes('WhatsApp connection failed')) {
          cleanup();
          const error = new Error('WhatsApp connection failed');
          await updateBridgeState(BRIDGE_STATES.ERROR, error);
          reject(error);
        }
      };

      matrixClient.on('Room.timeline', handleResponse);
      
      // Send login command
      matrixClient.sendTextMessage(
        bridgeRoom.room_id,
        BRIDGE_CONFIGS.whatsapp.loginCommand
      ).catch(async (error) => {
        cleanup();
        logger.error('Failed to send WhatsApp login command:', error);
        await updateBridgeState(BRIDGE_STATES.ERROR, error);
        reject(error);
      });
    });
  } catch (error) {
    logger.error('WhatsApp bridge handler error:', error);
    await updateBridgeState(BRIDGE_STATES.ERROR, error);
    throw error;
  }
}

export async function handleTelegramBridge(matrixClient, userId, botToken) {
  const bridgeRoom = await createBridgeRoom(matrixClient, 'telegram');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Telegram bridge timeout')), BRIDGE_TIMEOUTS.telegram);

    const handleResponse = async (event, room) => {
      if (room.roomId !== bridgeRoom.room_id) return;
      if (event.getType() !== 'm.room.message') return;

      const content = event.getContent().body;
      if (content.includes(BRIDGE_CONFIGS.telegram.successMessage)) {
        clearTimeout(timeout);
        matrixClient.removeListener('Room.timeline', handleResponse);

        const { error } = await supabase.from('accounts').upsert({
          user_id: userId,
          platform: 'telegram',
          status: 'active',
          credentials: {
            bridge_room_id: bridgeRoom.room_id,
            bot_token: botToken
          },
          connected_at: new Date().toISOString()
        });

        if (error) {
          reject(error);
          return;
        }

        resolve({ status: 'connected', bridgeRoomId: bridgeRoom.room_id });
      }
    };

    matrixClient.on('Room.timeline', handleResponse);

    matrixClient.sendMessage(bridgeRoom.room_id, {
      msgtype: 'm.text',
      body: `${BRIDGE_CONFIGS.telegram.loginCommand} ${botToken}`
    });
  });
}

export async function handleDiscordBridge(matrixClient, userId, credentials) {
  const bridgeRoom = await createBridgeRoom(matrixClient, 'discord');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord bridge timeout')), BRIDGE_TIMEOUTS.discord);

    const handleResponse = async (event, room) => {
      if (room.roomId !== bridgeRoom.room_id) return;
      if (event.getType() !== 'm.room.message') return;

      const content = event.getContent().body;
      if (content.includes(BRIDGE_CONFIGS.discord.successMessage)) {
        clearTimeout(timeout);
        matrixClient.removeListener('Room.timeline', handleResponse);

        const { error } = await supabase.from('accounts').upsert({
          user_id: userId,
          platform: 'discord',
          status: 'active',
          credentials: {
            bridge_room_id: bridgeRoom.room_id,
            ...credentials
          },
          connected_at: new Date().toISOString()
        });

        if (error) {
          reject(error);
          return;
        }

        resolve({ status: 'connected', bridgeRoomId: bridgeRoom.room_id });
      }
    };

    matrixClient.on('Room.timeline', handleResponse);

    matrixClient.sendMessage(bridgeRoom.room_id, {
      msgtype: 'm.text',
      body: `${BRIDGE_CONFIGS.discord.loginCommand} ${credentials.token}`
    });
  });
} 