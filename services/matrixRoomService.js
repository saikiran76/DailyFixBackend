import { adminClient } from '../utils/supabase.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';

class MatrixRoomService {
  constructor() {
    this.matrixClients = new Map();
  }

  setupSyncHandler(userId, matrixClient) {
    this.matrixClients.set(userId, matrixClient);

    // Handle room invites
    matrixClient.on('RoomMember.membership', async (event, member) => {
      if (member.membership === 'invite' && member.userId === matrixClient.getUserId()) {
        const room = matrixClient.getRoom(member.roomId);
        const inviter = room.getMember(event.getSender());
        
        // Check if invite is from WhatsApp bridge bot
        if (inviter.userId === BRIDGE_CONFIGS.whatsapp.bridgeBot) {
          console.log('Received WhatsApp bridge room invite:', room.roomId);
          
          try {
            // Auto-join the room
            await matrixClient.joinRoom(room.roomId);
            console.log('Joined WhatsApp bridge room:', room.roomId);

            // Wait for room state to sync with longer timeout
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Room state sync timeout')), 30000);
              
              const checkRoomState = () => {
                const updatedRoom = matrixClient.getRoom(room.roomId);
                if (updatedRoom && updatedRoom.currentState) {
                  clearTimeout(timeout);
                  resolve(updatedRoom);
                } else {
                  setTimeout(checkRoomState, 1000);
                }
              };
              checkRoomState();
            });

            // Get updated room after sync
            const updatedRoom = matrixClient.getRoom(room.roomId);
            
            // First verify WhatsApp connection by checking logins
            await matrixClient.sendMessage(BRIDGE_CONFIGS.whatsapp.bridgeRoomId, {
              msgtype: 'm.text',
              body: '!wa list-logins'
            });

            // Wait for login verification response
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Extract WhatsApp contact info from room name or state
            let whatsappId = null;
            const roomName = updatedRoom.name;
            const phoneMatch = roomName.match(/([0-9]+)/);
            if (phoneMatch) {
              whatsappId = phoneMatch[0];
            }

            if (!whatsappId) {
              const whatsappData = updatedRoom.currentState.getStateEvents('m.room.whatsapp');
              if (whatsappData && whatsappData[0]) {
                const content = whatsappData[0].getContent();
                whatsappId = content.whatsapp_id;
              }
            }

            if (whatsappId) {
              console.log('Found WhatsApp ID:', whatsappId);

              // Resolve the identifier first
              await matrixClient.sendMessage(BRIDGE_CONFIGS.whatsapp.bridgeRoomId, {
                msgtype: 'm.text',
                body: `!wa resolve-identifier ${whatsappId}`
              });

              // Wait for identifier resolution
              await new Promise(resolve => setTimeout(resolve, 2000));

              // Start the chat properly
              await matrixClient.sendMessage(BRIDGE_CONFIGS.whatsapp.bridgeRoomId, {
                msgtype: 'm.text',
                body: `!wa start-chat ${whatsappId}`
              });

              // Wait for chat initialization
              await new Promise(resolve => setTimeout(resolve, 2000));

              // Store contact in database
              const { data: contact, error } = await adminClient
                .from('whatsapp_contacts')
                .upsert({
                  user_id: userId,
                  whatsapp_id: whatsappId,
                  display_name: updatedRoom.name,
                  bridge_room_id: updatedRoom.roomId,
                  sync_status: 'active',
                  metadata: {
                    room_name: updatedRoom.name,
                    inviter: inviter.userId,
                    invited_at: new Date().toISOString()
                  }
                }, {
                  onConflict: 'user_id,whatsapp_id',
                  returning: true
                });

              if (error) throw error;

              // Emit socket event for frontend
              global.io.to(`user:${userId}`).emit('whatsapp:contact_added', contact);
            } else {
              console.warn('Could not extract WhatsApp ID from room:', updatedRoom.roomId);
            }
          } catch (error) {
            console.error('Error handling WhatsApp room invite:', error);
            // Try to clean up if something went wrong
            try {
              if (room && room.roomId) {
                await matrixClient.leave(room.roomId);
              }
            } catch (cleanupError) {
              console.error('Error during cleanup:', cleanupError);
            }
          }
        }
      }
    });

    // Rest of the existing message handling code...
  }
}

export const matrixRoomService = new MatrixRoomService();