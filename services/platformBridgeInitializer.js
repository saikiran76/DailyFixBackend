import { BRIDGE_CONFIGS, BRIDGE_TIMEOUTS } from '../config/bridgeConfig.js';
import { supabase } from '../utils/supabase.js';
import { ioEmitter } from '../utils/emitter.js';

export async function createBridgeRoom(matrixClient, platform) {
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

export async function initializeBridgeConnection(matrixClient, userId, platform, credentials = {}) {
  const bridgeRoom = await createBridgeRoom(matrixClient, platform);
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${platform} bridge connection timeout`)),
      BRIDGE_TIMEOUTS[platform]
    );

    const handleResponse = async (event, room) => {
      if (room.roomId !== bridgeRoom.room_id) return;
      if (event.getType() !== 'm.room.message') return;

      const content = event.getContent().body;
      
      // Handle platform-specific responses
      switch (platform) {
        case 'whatsapp':
          if (content.includes(BRIDGE_CONFIGS.whatsapp.qrPrefix)) {
            ioEmitter.emit('whatsapp_qr', {
              userId,
              qrCode: content.replace(BRIDGE_CONFIGS.whatsapp.qrPrefix, '').trim()
            });
          }
          break;
        // Add other platform-specific handlers
      }

      if (content.includes('Successfully logged in')) {
        clearTimeout(timeout);
        matrixClient.removeListener('Room.timeline', handleResponse);
        
        // Save bridge details
        const { error } = await supabase
          .from('accounts')
          .upsert({
            user_id: userId,
            platform,
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

    // Send platform-specific login command
    const loginCommand = platform === 'whatsapp' 
      ? BRIDGE_CONFIGS[platform].loginCommand
      : `${BRIDGE_CONFIGS[platform].loginCommand} ${credentials.token || ''}`;

    matrixClient.sendMessage(bridgeRoom.room_id, {
      msgtype: 'm.text',
      body: loginCommand
    });
  });
} 