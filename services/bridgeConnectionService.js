import sdk from 'matrix-js-sdk';
import { supabase } from '../utils/supabase.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';

export async function connectPlatformViaBridge(userId, platform, credentials) {
  let matrixClient;
  let cleanup;

  try {
    const { data: matrixAccount, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'matrix')
      .eq('status', 'active')
      .single();

    if (error || !matrixAccount) {
      throw new Error('Matrix account required for bridge connection');
    }

    matrixClient = sdk.createClient({
      baseUrl: matrixAccount.credentials.homeserver,
      accessToken: matrixAccount.credentials.accessToken,
      userId: matrixAccount.credentials.userId
    });

    // Create a private room with the bridge bot
    const bridgeRoom = await matrixClient.createRoom({
      visibility: 'private',
      invite: [BRIDGE_CONFIGS[platform].bridgeBot]
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Bridge connection timeout'));
      }, BRIDGE_TIMEOUTS[platform]);

      const handleResponse = async (event, room) => {
        if (room.roomId !== bridgeRoom.room_id) return;
        if (event.getType() !== 'm.room.message') return;

        const content = event.getContent();
        if (content.body.includes(BRIDGE_CONFIGS[platform].successMessage)) {
          cleanup();
          
          const { error: upsertError } = await supabase
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
            }, {
              onConflict: 'user_id,platform'
            });

          if (upsertError) {
            reject(upsertError);
            return;
          }

          resolve({ status: 'connected', bridgeRoomId: bridgeRoom.room_id });
        }
      };

      cleanup = () => {
        clearTimeout(timeout);
        matrixClient.removeListener('Room.timeline', handleResponse);
      };

      matrixClient.on('Room.timeline', handleResponse);

      matrixClient.sendMessage(bridgeRoom.room_id, {
        msgtype: 'm.text',
        body: `${BRIDGE_CONFIGS[platform].loginCommand} ${credentials.token || ''}`
      });
    });
  } catch (error) {
    if (cleanup) cleanup();
    throw error;
  }
} 