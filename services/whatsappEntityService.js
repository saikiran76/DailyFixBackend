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
        .select('id, whatsapp_id')
        .eq('id', contactId)
        .eq('user_id', userId)
        .single();

      if (contactError) throw contactError;
      if (!contact) throw new Error('Contact not found');

      // Create sync request
      const { data: syncRequest, error: syncError } = await adminClient
        .from('whatsapp_sync_requests')
        .upsert({
          user_id: userId,
          contact_id: contactId,
          status: 'pending',
          requested_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,contact_id',
          returning: true
        })
        .single();

      if (syncError) throw syncError;

      // Get or initialize Matrix client
      let matrixClient = matrixWhatsAppService.getMatrixClient(userId);
      if (!matrixClient) {
        try {
          // Get Matrix account from database
          const { data: matrixAccount, error: accountError } = await adminClient
            .from('accounts')
            .select('credentials')
            .eq('user_id', userId)
            .eq('platform', 'matrix')
            .single();

          if (accountError || !matrixAccount) {
            throw new Error('Matrix account not found');
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
        } catch (initError) {
          console.error('Matrix client initialization error:', initError);
          return { status: 'error', message: 'Failed to initialize Matrix client: ' + initError.message };
        }
      }

      // Start client if not running
      if (!matrixClient.clientRunning) {
        try {
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
                reject(new Error('Sync failed'));
              }
            });

            checkSync();
          });
        } catch (startError) {
          console.error('Failed to start Matrix client:', startError);
          return { status: 'error', message: 'Failed to sync Matrix client: ' + startError.message };
        }
      }

      // Step 4: Verify WhatsApp bridge connection and fetch contacts
      const bridgeRoomId = whatsappAccount.credentials?.bridge_room_id;
      if (!bridgeRoomId) {
        return { status: 'error', message: 'WhatsApp bridge room not found' };
      }

      try {
        // Get last sync token if available
        const lastSyncToken = whatsappAccount.credentials?.metadata?.last_sync_token;
        
        // Initialize tracking variables
        const whatsappRooms = new Map();
        const skippedRooms = [];
        const savedContacts = [];
        const updatedContacts = [];
        const failedContacts = [];
        
        // Create a simpler sync filter
        const filter = {
          room: {
            state: { 
              types: [
                'm.room.name',
                'm.room.member',
                'm.room.topic',
                'uk.half-shot.bridge'
              ]
            },
            timeline: {
              limit: 20
            }
          }
        };

        // Get rooms directly without sync
        console.log('Getting rooms...');
        const rooms = matrixClient.getRooms();
        console.log(`Found ${rooms.length} total rooms`);

        // Process each room
        for (const room of rooms) {
          try {
            // Check if room has the bridge bot
            const bridgeBot = room.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
            if (!bridgeBot || !['join', 'invite'].includes(bridgeBot.membership)) {
              skippedRooms.push({ roomId: room.roomId, reason: 'no_bridge_bot' });
              continue;
            }

            const roomData = {
              id: room.roomId,
              name: room.name,
              topic: room.currentState.getStateEvents('m.room.topic', '')[0]?.getContent().topic,
              type: room.getMyMembership(),
              // Refined group detection logic
              is_group: (() => {
                const allMembers = room.getJoinedMembers();
                const relevantMembers = allMembers.filter(member => 
                  member.userId !== matrixClient.getUserId() && // Exclude the user themselves
                  member.userId !== BRIDGE_CONFIGS.whatsapp.bridgeBot // Exclude the WhatsApp bridge bot
                );
                return relevantMembers.length > 1; // More than 1 remaining member = group
              })(),
              members: room.getJoinedMembers().map(m => ({
                userId: m.userId,
                displayName: m.name,
                membership: m.membership
              })),
              bridgeBot: {
                userId: bridgeBot.userId,
                displayName: bridgeBot.name
              },
              state_events: room.currentState.getStateEvents('uk.half-shot.bridge')
            };

            whatsappRooms.set(room.roomId, roomData);
          } catch (error) {
            console.error(`Error processing room ${room.roomId}:`, error);
            skippedRooms.push({ roomId: room.roomId, reason: 'processing_error', error: error.message });
          }
        }

        console.log(`Found ${whatsappRooms.size} WhatsApp rooms (${skippedRooms.length} skipped)`);

        // Process contacts from rooms
        for (const [roomId, roomData] of whatsappRooms.entries()) {
          try {
            const whatsappId = extractWhatsAppId(roomData);
            if (!whatsappId) {
              console.warn(`Could not extract WhatsApp ID for room ${roomId}`);
              failedContacts.push({ roomId, reason: 'no_whatsapp_id' });
              continue;
            }

            // Check if contact already exists
            const { data: existingContact, error: fetchError } = await adminClient
              .from('whatsapp_contacts')
              .select('id, sync_status, metadata')
              .eq('user_id', userId)
              .eq('whatsapp_id', whatsappId)
              .single();

            if (fetchError) {
              console.error(`Error checking existing contact for room ${roomId}:`, fetchError);
              failedContacts.push({ 
                roomId, 
                reason: 'fetch_error', 
                error: fetchError.message 
              });
              continue;
            }

            // Prepare contact data
            const contactData = {
              user_id: userId,
              whatsapp_id: whatsappId,
              display_name: roomData.name || `WhatsApp ${whatsappId}`,
              bridge_room_id: roomId,
              sync_status: roomData.type === 'join' ? 'approved' : 'pending',
              metadata: {
                room_name: roomData.name,
                room_topic: roomData.topic,
                room_type: roomData.type,
                members: roomData.members,
                bridge_bot: roomData.bridgeBot,
                state_events: roomData.state_events,
                updated_at: new Date().toISOString()
              }
            };

            // Validate contact data
            const validationErrors = [];
            if (!contactData.user_id) validationErrors.push('missing_user_id');
            if (!contactData.whatsapp_id) validationErrors.push('missing_whatsapp_id');
            if (!contactData.bridge_room_id) validationErrors.push('missing_bridge_room_id');

            if (validationErrors.length > 0) {
              console.error(`Invalid contact data for room ${roomId}:`, validationErrors);
              failedContacts.push({ 
                roomId, 
                reason: 'validation_error', 
                errors: validationErrors 
              });
              continue;
            }

            // Compare with existing data to check if update needed
            let needsUpdate = false;
            if (existingContact) {
              needsUpdate = (
                existingContact.sync_status !== contactData.sync_status ||
                JSON.stringify(existingContact.metadata) !== JSON.stringify(contactData.metadata)
              );
            }

            if (existingContact && !needsUpdate) {
              console.log(`Contact for room ${roomId} is up to date`);
              continue;
            }

            // Perform upsert
            const { data, error } = await adminClient
              .from('whatsapp_contacts')
              .upsert(contactData, {
                onConflict: 'user_id,whatsapp_id',
                returning: true
              });

            if (error) {
              console.error(`Failed to save contact for room ${roomId}:`, error);
              failedContacts.push({ 
                roomId, 
                reason: 'db_error', 
                error: error.message 
              });
            } else {
              if (existingContact) {
                updatedContacts.push(data);
          } else {
              savedContacts.push(data);
              }
            }
          } catch (error) {
            console.error(`Error processing contact for room ${roomId}:`, error);
            failedContacts.push({ 
              roomId, 
              reason: 'processing_error', 
              error: error.message 
            });
          }
        }

        console.log(`Contact sync results:`, {
          new: savedContacts.length,
          updated: updatedContacts.length,
          failed: failedContacts.length,
          skipped: whatsappRooms.size - (savedContacts.length + updatedContacts.length + failedContacts.length)
        });

        if (failedContacts.length > 0) {
          console.warn('Failed contacts:', failedContacts);
        }

        // Store sync results with enhanced status tracking
        if (lastSyncToken) {
          console.log('Storing sync token and results');
          try {
            const syncResults = {
              timestamp: new Date().toISOString(),
              rooms_found: whatsappRooms.size,
              rooms_skipped: skippedRooms.length,
              contacts_new: savedContacts.length,
              contacts_updated: updatedContacts.length,
              contacts_failed: failedContacts.length,
              skipped_rooms: skippedRooms,
              failed_contacts: failedContacts
            };

            const { error: updateError } = await adminClient
              .from('accounts')
              .update({
                credentials: {
                  ...whatsappAccount.credentials,
                  metadata: {
                    ...whatsappAccount.credentials?.metadata,
                    last_sync_token: lastSyncToken,
                    last_sync_status: syncResults,
                    sync_history: [
                      ...(whatsappAccount.credentials?.metadata?.sync_history || []).slice(-4),
                      syncResults
                    ]
                  }
                }
              })
              .eq('user_id', userId)
              .eq('platform', 'whatsapp');

            if (updateError) {
              console.error('Failed to store sync results:', updateError);
            }
          } catch (error) {
            console.error('Error storing sync results:', error);
          }
        }

        // Send sync request command to bridge bot
        await matrixClient.sendMessage(BRIDGE_CONFIGS.whatsapp.bridgeBot, {
          msgtype: 'm.text',
          body: `!wa sync ${contact.whatsapp_id}`
        });

        return syncRequest;
      } catch (error) {
        console.error('Error processing WhatsApp rooms:', error);
        throw error;
      }
    } catch (error) {
      console.error('Error requesting WhatsApp sync:', error);
      throw error;
    }
  }

  async getMessages(userId, contactId, limit = 50, before = null) {
    try {
      // Verify sync is approved
      const { data: syncRequest, error: syncError } = await adminClient
        .from('whatsapp_sync_requests')
        .select('status')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .single();

      if (syncError) throw syncError;
      if (!syncRequest || syncRequest.status !== 'approved') {
        throw new Error('Sync not approved for this contact');
      }

      // Build query
      let query = adminClient
        .from('whatsapp_messages')
        .select(`
          id,
          message_id,
          content,
          sender_id,
          sender_name,
          message_type,
          timestamp,
          is_read,
          metadata
        `)
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (before) {
        query = query.lt('timestamp', before);
      }

      const { data: messages, error } = await query;
      if (error) throw error;

      return messages;
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