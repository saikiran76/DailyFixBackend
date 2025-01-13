import { adminClient } from '../utils/supabase.js';
import { matrixWhatsAppService }  from './matrixWhatsAppService.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';
import * as sdk from 'matrix-js-sdk';
import { getIO } from '../utils/socket.js';

// Helper function to extract WhatsApp ID from room data
// function extractWhatsAppId(roomData) {
//   try {
//     // For groups, use the room name as identifier
//     if (roomData.is_group) {
//       return roomData.name?.replace(' (WA)', '').trim() || null;
//     }

//     // Check bridge state events first as they're most reliable
//     const bridgeEvent = roomData.state_events?.[0]?.getContent();
//     if (bridgeEvent?.remote_id) {
//       return bridgeEvent.remote_id;
//     }

//     // Check room name for phone numbers
//     const phoneRegex = /\+\d{10,}/;
//     const nameMatch = roomData.name?.match(phoneRegex);
//     if (nameMatch) {
//       return nameMatch[0];
//     }

//     // Check room topic
//     const topicMatch = roomData.topic?.match(phoneRegex);
//     if (topicMatch) {
//       return topicMatch[0];
//     }

//     // For personal chats with (WA) suffix
//     if (roomData.name?.endsWith('(WA)')) {
//       const cleanName = roomData.name.replace('(WA)', '').trim();
//       // Only use if it looks like a contact name or number
//       if (cleanName.length > 0) {
//         return cleanName;
//       }
//     }

//     return null;
//   } catch (error) {
//     console.error('Error extracting WhatsApp ID:', error);
//     return null;
//   }
// }

class WhatsAppEntityService {
  constructor() {
    this.whatsappRooms = [];
    this.skippedRooms = [];
    this.failedContacts = [];
    this.extractWhatsAppId = this.extractWhatsAppId.bind(this);
  }

  extractWhatsAppId(roomData) {
    try {
      // First try bridge state events as they're most reliable
      const bridgeEvent = roomData.state_events?.find(event => 
        event.type === 'uk.half-shot.bridge' && 
        event.content?.bridge === 'whatsapp'
      );
      
      if (bridgeEvent?.content?.remote?.id) {
        console.log(`[WhatsApp ID] Found from bridge event: ${bridgeEvent.content.remote.id}`);
        return bridgeEvent.content.remote.id;
      }

      // For groups, try multiple approaches
      if (roomData.is_group) {
        // Try room name first
        if (roomData.name) {
          const groupName = roomData.name.replace(' (WA)', '').trim();
          if (groupName) {
            console.log(`[WhatsApp ID] Found from group name: ${groupName}`);
            return groupName.replace(/\s+/g, '_').toLowerCase();
          }
        }
        
        // Try topic as fallback for groups
        if (roomData.topic) {
          console.log(`[WhatsApp ID] Found from group topic: ${roomData.topic}`);
          return roomData.topic.replace(/\s+/g, '_').toLowerCase();
        }
      }

      // For personal chats, try multiple approaches
      // 1. Try phone number in name or topic
      const phoneRegex = /\+?[\d\s-]{10,}/;
      const nameMatch = roomData.name?.match(phoneRegex);
      const topicMatch = roomData.topic?.match(phoneRegex);
      
      if (nameMatch) {
        const phone = nameMatch[0].replace(/[\s-]/g, '');
        console.log(`[WhatsApp ID] Found phone from name: ${phone}`);
        return phone;
      }
      
      if (topicMatch) {
        const phone = topicMatch[0].replace(/[\s-]/g, '');
        console.log(`[WhatsApp ID] Found phone from topic: ${phone}`);
        return phone;
      }

      // 2. Try (WA) suffix format
      if (roomData.name?.endsWith('(WA)')) {
        const cleanName = roomData.name.slice(0, -4).trim();
        if (cleanName) {
          console.log(`[WhatsApp ID] Found from WA suffix: ${cleanName}`);
          return cleanName;
        }
      }

      // 3. Last resort - use sanitized room name if nothing else works
      if (roomData.name) {
        const sanitizedName = roomData.name
          .replace(/[^\w\s-]/g, '') // Remove special chars
          .trim()
          .replace(/\s+/g, '_')
          .toLowerCase();
          
        if (sanitizedName) {
          console.log(`[WhatsApp ID] Using sanitized room name as fallback: ${sanitizedName}`);
          return sanitizedName;
        }
      }

      console.log(`[WhatsApp ID] Failed to extract ID for room: ${roomData.roomId}`);
      return null;
    } catch (error) {
      console.error('[WhatsApp ID] Error extracting WhatsApp ID:', error);
      return null;
    }
  }

  async getMatrixClient(userId) {
    try {
      // First check if we already have an initialized client
      let matrixClient = matrixWhatsAppService.getMatrixClient(userId);
      if (matrixClient) {
        return matrixClient;
      }

      // Get Matrix account from database
      const { data: matrixAccount, error: accountError } = await adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (accountError || !matrixAccount) {
        console.error('Matrix account fetch error:', accountError);
        return null;
      }

      // Create Matrix client with correct credentials
      matrixClient = sdk.createClient({
        baseUrl: matrixAccount.credentials.homeserver,
        accessToken: matrixAccount.credentials.accessToken,
        userId: matrixAccount.credentials.userId,
        timeoutMs: 30000,
        useAuthorizationHeader: true
      });

      // Store in service
      matrixWhatsAppService.matrixClients.set(userId, matrixClient);

      // Start client if not running
      if (!matrixClient.clientRunning) {
        console.log('Starting Matrix client...');
        await matrixClient.startClient();
        
        // Wait for initial sync
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Initial sync timeout')), 30000);
          
          const checkSync = () => {
            if (matrixClient.isInitialSyncComplete()) {
              clearTimeout(timeout);
              resolve();
              return;
            }
            setTimeout(checkSync, 1000);
          };

          matrixClient.once('sync', (state) => {
            if (state === 'PREPARED') {
              clearTimeout(timeout);
              resolve();
            } else if (state === 'ERROR') {
              clearTimeout(timeout);
              reject(new Error('Sync failed with state: ' + state));
            }
          });

          checkSync();
        });
      }

      return matrixClient;
    } catch (error) {
      console.error('Error getting Matrix client:', error);
      return null;
    }
  }

  async getContacts(userId) {
    try {
      // Initialize tracking variables
      const whatsappRooms = [];
      const skippedRooms = [];
      const savedContacts = [];
      const updatedContacts = [];
      const failedContacts = [];

      // Get Matrix client
      const matrixClient = await this.getMatrixClient(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get all rooms
      const rooms = matrixClient.getRooms();
      console.log(`[Contacts] Found ${rooms.length} total rooms`);

        // Process each room
      for (const [index, room] of rooms.entries()) {
          try {
          // Check if room has bridge bot
          const bridgeBot = room.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
            if (!bridgeBot || !['join', 'invite'].includes(bridgeBot.membership)) {
            skippedRooms.push({
              roomId: room.roomId,
              reason: 'no_bridge_bot'
            });
              continue;
            }

          // Auto-join if invited
          if (bridgeBot.membership === 'invite') {
            console.log(`[Contacts] Auto-joining room ${room.roomId}`);
            try {
            await matrixClient.joinRoom(room.roomId);
            } catch (joinError) {
              console.error(`[Contacts] Failed to join room ${room.roomId}:`, joinError);
              // Continue processing even if join fails
            }
          }

          // Get room data with enhanced group detection
          const allMembers = room.getJoinedMembers();
          const relevantMembers = allMembers.filter(member => 
            member.userId !== matrixClient.getUserId() && 
            member.userId !== BRIDGE_CONFIGS.whatsapp.bridgeBot &&
            !member.userId.includes('whatsapp-bridge') // Exclude any bridge-related users
          );

            const roomData = {
            roomId: room.roomId,
              name: room.name,
              topic: room.currentState.getStateEvents('m.room.topic', '')[0]?.getContent().topic,
            state_events: room.currentState.getStateEvents('uk.half-shot.bridge'),
            members: relevantMembers,
            is_group: relevantMembers.length > 1 || room.name?.toLowerCase().includes('group')
          };

          // Extract WhatsApp ID with enhanced logging
          const whatsappId = this.extractWhatsAppId(roomData);
          if (!whatsappId) {
            failedContacts.push({
              roomId: room.roomId,
              error: 'Failed to extract WhatsApp ID',
              roomData: {
                name: roomData.name,
                topic: roomData.topic,
                memberCount: relevantMembers.length
              }
            });
            continue;
          }

          // Create contact data
          const contactData = {
            user_id: userId,
            whatsapp_id: whatsappId,
            display_name: room.name,
            sync_status: bridgeBot.membership === 'join' ? 'approved' : 'pending',
            is_group: roomData.is_group,
            unread_count: 0,
            metadata: {
              room_id: room.roomId,
              room_type: bridgeBot.membership,
              member_count: relevantMembers.length
            }
          };

          // Save or update contact
          const { data: existingContact } = await adminClient
            .from('whatsapp_contacts')
            .select('id')
            .eq('user_id', userId)
            .eq('whatsapp_id', whatsappId)
            .maybeSingle();

          if (existingContact) {
            const { error: updateError } = await adminClient
              .from('whatsapp_contacts')
              .update(contactData)
              .eq('id', existingContact.id);

            if (updateError) {
            failedContacts.push({ 
                roomId: room.roomId,
                error: `Failed to update contact: ${updateError.message}`
            });
            } else {
              updatedContacts.push(contactData);
          }
          } else {
            const { error: insertError } = await adminClient
            .from('whatsapp_contacts')
              .insert(contactData);

            if (insertError) {
              failedContacts.push({
                roomId: room.roomId,
                error: `Failed to save contact: ${insertError.message}`
              });
          } else {
              savedContacts.push(contactData);
            }
          }

          whatsappRooms.push(roomData);
        } catch (roomError) {
          console.error(`Error processing room ${room.roomId}:`, roomError);
          failedContacts.push({
            roomId: room.roomId,
            error: roomError.message
          });
        }
      }

      return {
        status: 'success',
        data: {
          rooms_found: rooms.length,
          whatsapp_rooms: whatsappRooms.length,
          skipped_rooms: skippedRooms.length,
          saved_contacts: savedContacts.length,
          updated_contacts: updatedContacts.length,
          failed_contacts: failedContacts.length,
          contacts: [...savedContacts, ...updatedContacts],
          errors: failedContacts
        }
      };
        } catch (error) {
      console.error('Error getting contacts:', error);
          return {
            status: 'error',
        message: error.message
      };
    }
  }

  async requestSync(userId, contactId) {
    try {
      // Verify contact belongs to user
      const { data: contact, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id, metadata')
        .eq('id', contactId)
        .eq('user_id', userId)
        .single();

      if (contactError || !contact) {
        throw new Error('Contact not found');
      }

      // Get Matrix client
      const matrixClient = await this.getMatrixClient(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Request sync using Matrix's native sync
      const syncResult = await matrixWhatsAppService.syncMessages(userId, contactId);

      // Return sync request status
      return {
        status: 'success',
        data: {
          sync_status: 'pending',
          message: 'Sync initiated using Matrix native sync',
          details: syncResult
        }
      };

    } catch (error) {
      console.error('Error requesting WhatsApp sync:', error);
      
      // Update sync request status on error
      await this.updateSyncStatus(userId, contactId, 'rejected');
      
      throw error;
    }
  }

  async getMessages(userId, contactId, limit = 50, before = null) {
    try {
      // Check sync request status first
      const { data: syncRequest, error: syncError } = await adminClient
        .from('whatsapp_sync_requests')
        .select('status')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .maybeSingle();

      if (syncError) throw syncError;

      // If no sync request exists or it's not approved, trigger a sync
      if (!syncRequest || syncRequest.status !== 'approved') {
        await this.requestSync(userId, contactId);
        return []; // Return empty array while syncing
      }

      // Build query
      let query = adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (before) {
        query = query.lt('timestamp', before);
      }

      const { data: messages, error } = await query;
      if (error) throw error;

      return messages || [];
    } catch (error) {
      console.error('Error fetching WhatsApp messages:', error);
      throw error;
    }
  }

  async updateSyncStatus(userId, contactId, status) {
    try {
      const { data, error } = await adminClient
        .from('whatsapp_sync_requests')
        .update({
          status,
          approved_at: status === 'approved' ? new Date().toISOString() : null
        })
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating sync status:', error);
      throw error;
    }
  }

  async updateUnreadCount(userId, contactId, count) {
    try {
      const { data, error } = await adminClient
        .from('whatsapp_contacts')
        .update({ unread_count: count })
        .eq('user_id', userId)
        .eq('id', contactId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating unread count:', error);
      throw error;
    }
  }

  async markMessagesAsRead(userId, contactId, messageIds) {
    try {
      const { data, error } = await adminClient
        .from('whatsapp_messages')
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .in('message_id', messageIds);

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error marking messages as read:', error);
      throw error;
    }
  }
}

export const whatsappEntityService = new WhatsAppEntityService(); 