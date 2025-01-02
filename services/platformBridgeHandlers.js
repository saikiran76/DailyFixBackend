import sdk from 'matrix-js-sdk';
import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
import { supabase } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';

async function createBridgeRoom(matrixClient, platform) {
  const room = await matrixClient.createRoom({
    visibility: 'private',
    invite: [BRIDGE_CONFIGS[platform].bridgeBot]
  });

  // Wait for bridge bot to join
  await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 5000);
    matrixClient.on('RoomMember.membership', (event, member) => {
      if (member.roomId === room.room_id && 
          member.userId === BRIDGE_CONFIGS[platform].bridgeBot && 
          member.membership === 'join') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  return room;
}

export async function handleWhatsAppBridge(matrixClient, userId) {
  try {
    const bridgeRoom = await createBridgeRoom(matrixClient, 'whatsapp');
    
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        matrixClient.removeListener('Room.timeline', handleResponse);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('WhatsApp bridge timeout'));
      }, BRIDGE_TIMEOUTS.whatsapp);

      const handleResponse = async (event, room) => {
        if (room.roomId !== bridgeRoom.room_id) return;
        if (event.getType() !== 'm.room.message') return;

        const content = event.getContent().body;
        console.log('Bridge response:', content); // Debug log

        // Check for QR code in response
        if (content.includes(BRIDGE_CONFIGS.whatsapp.qrPrefix)) {
          const qrCode = content.replace(BRIDGE_CONFIGS.whatsapp.qrPrefix, '').trim();
          console.log('QR Code received, emitting to client'); // Debug log
          ioEmitter.emit('whatsapp_qr', {
            userId,
            qrCode
          });
          return; // Don't resolve yet - wait for successful connection
        }

        // Check for successful connection
        if (content.includes(BRIDGE_CONFIGS.whatsapp.connected)) {
          console.log('WhatsApp successfully connected'); // Debug log
          cleanup();
          
          const { error } = await supabase.from('accounts').upsert({
            user_id: userId,
            platform: 'whatsapp',
            status: 'active',
            credentials: {
              bridge_room_id: bridgeRoom.room_id
            },
            connected_at: new Date().toISOString()
          });

          if (error) {
            reject(error);
            return;
          }

          resolve({ 
            status: 'connected',
            bridgeRoomId: bridgeRoom.room_id 
          });
        }
      };

      // Start listening for responses
      matrixClient.on('Room.timeline', handleResponse);

      // Send WhatsApp login command after a short delay to ensure room is ready
      setTimeout(() => {
        console.log('Sending WhatsApp login command'); // Debug log
        matrixClient.sendMessage(bridgeRoom.room_id, {
          msgtype: 'm.text',
          body: BRIDGE_CONFIGS.whatsapp.loginCommand
        });
      }, 2000);
    });
  } catch (error) {
    console.error('WhatsApp bridge initialization error:', error);
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