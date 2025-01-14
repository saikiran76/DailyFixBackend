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
  constructor(supabaseClient) {
    this.supabaseClient = supabaseClient;
    this.syncLocks = new Map(); // Add sync lock tracking
    this.whatsappRooms = [];
    this.skippedRooms = [];
    this.failedContacts = [];
    this.extractWhatsAppId = this.extractWhatsAppId.bind(this);
  }

  extractWhatsAppId(roomData) {
    try {
      let whatsappId = null;

      // First try bridge state events as they're most reliable
      const bridgeEvent = roomData.state_events?.find(event => 
        event.type === 'uk.half-shot.bridge' && 
        event.content?.bridge === 'whatsapp'
      );
      
      if (bridgeEvent?.content?.remote?.id) {
        whatsappId = bridgeEvent.content.remote.id;
        console.log(`[WhatsApp ID] Found from bridge event: ${whatsappId}`);
        return this.normalizeWhatsAppId(whatsappId);
      }

      // For groups, try multiple approaches
      if (roomData.is_group) {
        // Try room name first
        if (roomData.name) {
          const groupName = roomData.name.replace(' (WA)', '').trim();
          if (groupName) {
            whatsappId = groupName.replace(/\s+/g, '_');
            console.log(`[WhatsApp ID] Found from group name: ${whatsappId}`);
            return this.normalizeWhatsAppId(whatsappId);
          }
        }
        
        // Try topic as fallback for groups
        if (roomData.topic) {
          whatsappId = roomData.topic.replace(/\s+/g, '_');
          console.log(`[WhatsApp ID] Found from group topic: ${whatsappId}`);
          return this.normalizeWhatsAppId(whatsappId);
        }
      }

      // For personal chats, try multiple approaches
      // 1. Try phone number in name or topic
      const phoneRegex = /\+?[\d\s-]{10,}/;
      const nameMatch = roomData.name?.match(phoneRegex);
      const topicMatch = roomData.topic?.match(phoneRegex);
      
      if (nameMatch) {
        whatsappId = nameMatch[0].replace(/[\s-]/g, '');
        console.log(`[WhatsApp ID] Found phone from name: ${whatsappId}`);
        return this.normalizeWhatsAppId(whatsappId);
      }
      
      if (topicMatch) {
        whatsappId = topicMatch[0].replace(/[\s-]/g, '');
        console.log(`[WhatsApp ID] Found phone from topic: ${whatsappId}`);
        return this.normalizeWhatsAppId(whatsappId);
      }

      // 2. Try (WA) suffix format
      if (roomData.name?.endsWith('(WA)')) {
        whatsappId = roomData.name.slice(0, -4).trim();
        if (whatsappId) {
          console.log(`[WhatsApp ID] Found from WA suffix: ${whatsappId}`);
          return this.normalizeWhatsAppId(whatsappId);
        }
      }

      // 3. Last resort - use sanitized room name if nothing else works
      if (roomData.name) {
        whatsappId = roomData.name
          .replace(/[^\w\s-]/g, '') // Remove special chars
          .trim()
          .replace(/\s+/g, '_');
          
        if (whatsappId) {
          console.log(`[WhatsApp ID] Using sanitized room name as fallback: ${whatsappId}`);
          return this.normalizeWhatsAppId(whatsappId);
        }
      }

      console.log(`[WhatsApp ID] Failed to extract ID for room: ${roomData.roomId}`);
      return null;
    } catch (error) {
      console.error('[WhatsApp ID] Error extracting WhatsApp ID:', error);
      return null;
    }
  }

  normalizeWhatsAppId(whatsappId) {
    if (!whatsappId) return '';
    
    try {
      // Remove emojis and special characters but keep basic punctuation
      const normalized = whatsappId
        .normalize('NFD')  // Decompose characters
        .replace(/[\u0300-\u036f]/g, '')  // Remove diacritics
        .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')  // Remove emojis
        .replace(/[^\w\s\-_.]/g, '')  // Keep only word chars, spaces, hyphens, underscores, dots
        .toLowerCase()  // Convert to lowercase
        .trim();  // Remove leading/trailing spaces
      
      console.log('[WhatsApp ID] Normalized ID:', {
        original: whatsappId,
        normalized
      });
      
      return normalized;
    } catch (error) {
      console.error('[WhatsApp ID] Normalization error:', {
        whatsappId,
        error
      });
      // Return a safe fallback
      return whatsappId.toLowerCase().trim();
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
      const processedRoomIds = new Set();

      // Get Matrix client
      const matrixClient = await this.getMatrixClient(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Get all rooms
      const rooms = matrixClient.getRooms();
      console.log(`[Contacts] Found ${rooms.length} total rooms`);

      // First pass: Get existing contacts with enhanced duplicate detection
      console.log('[Contacts] Fetching existing contacts');
      const { data: existingContacts } = await adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('user_id', userId);

      // Create lookup maps for faster duplicate checking
      const contactsByRoomId = {};
      const contactsByWhatsAppId = {};
      const contactsByDisplayName = {};
      
      existingContacts?.forEach(contact => {
        // Index by room_id
        if (contact.metadata?.room_id) {
          contactsByRoomId[contact.metadata.room_id] = contact;
        }
        
        // Index by normalized whatsapp_id
        if (contact.whatsapp_id) {
          const normalizedId = this.normalizeWhatsAppId(contact.whatsapp_id);
          if (!contactsByWhatsAppId[normalizedId] || 
              (contact.bridge_room_id && !contactsByWhatsAppId[normalizedId].bridge_room_id)) {
            contactsByWhatsAppId[normalizedId] = contact;
          }
        }

        // Index by normalized display name (without WA suffix)
        if (contact.display_name) {
          const normalizedName = this.normalizeWhatsAppId(contact.display_name.replace(/\s*\(WA\)\s*$/, ''));
          if (!contactsByDisplayName[normalizedName] || 
              (contact.bridge_room_id && !contactsByDisplayName[normalizedName].bridge_room_id)) {
            contactsByDisplayName[normalizedName] = contact;
          }
        }
      });

      // Process each room
      for (const room of rooms) {
        try {
          const roomId = room.roomId;
          
          // Skip if we've already processed this room
          if (processedRoomIds.has(roomId)) {
            console.log(`[Contacts] Skipping already processed room: ${roomId}`);
            continue;
          }
          processedRoomIds.add(roomId);

          // Check if room has bridge bot
          const bridgeBot = room.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
          if (!bridgeBot || !['join', 'invite'].includes(bridgeBot.membership)) {
            skippedRooms.push({
              roomId,
              reason: 'no_bridge_bot'
            });
            continue;
          }

          // If bot is in invite state, automatically handle the invite
          if (bridgeBot.membership === 'invite') {
            console.log(`[Contacts] Bot invite found for room ${roomId}, attempting to handle...`);
            try {
              await matrixWhatsAppService.handleBotInvite(userId, roomId);
              console.log(`[Contacts] Successfully handled bot invite for room ${roomId}`);
              // Refresh room state after invite handling
              const updatedRoom = matrixClient.getRoom(roomId);
              const updatedBot = updatedRoom.currentState.getMember(BRIDGE_CONFIGS.whatsapp.bridgeBot);
              if (updatedBot.membership === 'join') {
                console.log(`[Contacts] Bot successfully joined room ${roomId}`);
              }
            } catch (inviteError) {
              console.error(`[Contacts] Failed to handle bot invite for room ${roomId}:`, inviteError);
              failedContacts.push({
                roomId,
                error: `Bot invite handling failed: ${inviteError.message}`
              });
              continue;
            }
          }

          // Get room data with enhanced group detection
          const allMembers = room.getJoinedMembers();
          const relevantMembers = allMembers.filter(member => 
            member.userId !== matrixClient.getUserId() && 
            member.userId !== BRIDGE_CONFIGS.whatsapp.bridgeBot &&
            !member.userId.includes('whatsapp-bridge')
          );

          const roomData = {
            roomId,
            name: room.name,
            topic: room.currentState.getStateEvents('m.room.topic', '')[0]?.getContent().topic,
            state_events: room.currentState.getStateEvents('uk.half-shot.bridge'),
            members: relevantMembers,
            is_group: relevantMembers.length > 1 || room.name?.toLowerCase().includes('group')
          };

          // Extract WhatsApp ID
          const whatsappId = this.extractWhatsAppId(roomData);
          if (!whatsappId) {
            failedContacts.push({
              roomId,
              error: 'Failed to extract WhatsApp ID',
              roomData: {
                name: roomData.name,
                topic: roomData.topic,
                memberCount: relevantMembers.length
              }
            });
            continue;
          }

          const normalizedWhatsAppId = this.normalizeWhatsAppId(whatsappId);
          const normalizedDisplayName = this.normalizeWhatsAppId(room.name?.replace(/\s*\(WA\)\s*$/, ''));
          
          console.log(`[Contacts] Processing contact:`, {
            normalizedWhatsAppId,
            normalizedDisplayName,
            roomId
          });

          // Create contact data
          const contactData = {
            user_id: userId,
            whatsapp_id: whatsappId,
            display_name: room.name,
            sync_status: bridgeBot.membership === 'join' ? 'approved' : 'pending',
            is_group: roomData.is_group,
            unread_count: 0,
            metadata: {
              room_id: roomId,
              room_type: bridgeBot.membership,
              member_count: relevantMembers.length
            },
            bridge_room_id: bridgeBot.membership === 'join' ? roomId : null
          };

          // Check for existing contact by room_id, whatsapp_id, or display_name
          const existingByRoom = contactsByRoomId[roomId];
          const existingByWhatsAppId = contactsByWhatsAppId[normalizedWhatsAppId];
          const existingByDisplayName = contactsByDisplayName[normalizedDisplayName];

          let contactToUpdate = existingByRoom || existingByWhatsAppId || existingByDisplayName;
          let savedContact = null;

          if (contactToUpdate) {
            console.log(`[Contacts] Updating existing contact:`, {
              id: contactToUpdate.id,
              foundBy: existingByRoom ? 'room_id' : 
                      existingByWhatsAppId ? 'whatsapp_id' : 'display_name'
            });

            const { data: updatedContact, error: updateError } = await adminClient
              .from('whatsapp_contacts')
              .update(contactData)
              .eq('id', contactToUpdate.id)
              .select('*')
              .single();

            if (updateError) {
              failedContacts.push({
                roomId,
                error: `Failed to update contact: ${updateError.message}`
              });
            } else {
              updatedContacts.push(updatedContact);
              savedContact = updatedContact;
              // Update lookup maps
              contactsByRoomId[roomId] = updatedContact;
              contactsByWhatsAppId[normalizedWhatsAppId] = updatedContact;
              contactsByDisplayName[normalizedDisplayName] = updatedContact;
            }
          } else {
            console.log(`[Contacts] Creating new contact for WhatsApp ID: ${whatsappId}`);
            const { data: newContact, error: insertError } = await adminClient
              .from('whatsapp_contacts')
              .insert(contactData)
              .select('*')
              .single();

            if (insertError) {
              failedContacts.push({
                roomId,
                error: `Failed to save contact: ${insertError.message}`
              });
            } else {
              savedContacts.push(newContact);
              savedContact = newContact;
              // Update lookup maps
              contactsByRoomId[roomId] = newContact;
              contactsByWhatsAppId[normalizedWhatsAppId] = newContact;
              contactsByDisplayName[normalizedDisplayName] = newContact;
            }
          }

          // If contact was saved/updated successfully and bot is joined, trigger sync
          if (savedContact && bridgeBot.membership === 'join') {
            try {
              console.log(`[Contacts] Triggering initial sync for contact:`, {
                contactId: savedContact.id,
                roomId: savedContact.metadata.room_id
              });
              
              let syncSuccess = false;
              let syncRetries = 0;
              const MAX_SYNC_RETRIES = 3;

              while (!syncSuccess && syncRetries < MAX_SYNC_RETRIES) {
                try {
                  await matrixWhatsAppService.syncMessages(userId, savedContact.id);
                  console.log(`[Contacts] Initial sync completed for contact ${savedContact.id}`);
                  syncSuccess = true;
                } catch (syncError) {
                  syncRetries++;
                  console.error(`[Contacts] Sync attempt ${syncRetries} failed for contact ${savedContact.id}:`, syncError);
                  
                  if (syncRetries < MAX_SYNC_RETRIES) {
                    console.log(`[Contacts] Retrying sync in ${syncRetries} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, syncRetries * 1000));
                  }
                }
              }

              if (!syncSuccess) {
                console.error(`[Contacts] All sync attempts failed for contact ${savedContact.id}`);
                // Update contact status to reflect sync failure
                await adminClient
                  .from('whatsapp_contacts')
                  .update({
                    sync_status: 'sync_failed',
                    metadata: {
                      ...savedContact.metadata,
                      last_sync_error: 'Failed after multiple attempts'
                    }
                  })
                  .eq('id', savedContact.id);
              }
            } catch (syncError) {
              console.error(`[Contacts] Failed to handle sync for contact ${savedContact.id}:`, syncError);
              // Don't fail the whole process, just log the error
            }
          }

          whatsappRooms.push(roomData);
        } catch (roomError) {
          console.error(`[Contacts] Error processing room ${room.roomId}:`, roomError);
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
      console.error('[Contacts] Error getting contacts:', error);
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

  async waitForSync(userId, contactId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkSync = async () => {
        try {
          const { data: contact } = await adminClient
            .from('whatsapp_contacts')
            .select('sync_status')
            .eq('user_id', userId)
            .eq('id', contactId)
            .single();

          if (contact?.sync_status === 'approved') {
            resolve(true);
          } else if (Date.now() - startTime > timeout) {
            reject(new Error('Sync timeout'));
          } else {
            setTimeout(checkSync, 1000);
          }
        } catch (error) {
          reject(error);
        }
      };

      checkSync();
    });
  }

  async getMessages(userId, contactId, limit = 50, before = null) {
    const lockKey = `${userId}-${contactId}`;
    if (this.syncLocks.get(lockKey)) {
      console.log('[WhatsApp Service] Sync already in progress for:', lockKey);
      return [];
    }

    try {
      this.syncLocks.set(lockKey, true);
      console.log('[WhatsApp Service] getMessages called with params:', {
        userId,
        contactId,
        limit,
        before,
        contactIdType: typeof contactId
      });

      // Input validation
      if (!userId || !contactId) {
        throw new Error('Missing required parameters: userId and contactId');
      }

      // Convert contactId to number if it's a string
      const numericContactId = typeof contactId === 'string' ? parseInt(contactId, 10) : contactId;
      if (isNaN(numericContactId)) {
        throw new Error('Invalid contact ID format');
      }
      console.log('[WhatsApp Service] Using numeric contactId:', numericContactId);

      // Get contact record with all necessary fields
      console.log('[WhatsApp Service] Fetching contact record');
      const { data: contact, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('id, whatsapp_id, metadata, sync_status, bridge_room_id')
        .eq('id', numericContactId)
        .eq('user_id', userId)
        .single();

      if (contactError) {
        console.error('[WhatsApp Service] Contact fetch error:', contactError);
        throw new Error(`Contact fetch failed: ${contactError.message}`);
      }

      if (!contact) {
        console.error('[WhatsApp Service] Contact not found:', { userId, contactId: numericContactId });
        throw new Error('Contact not found');
      }

      console.log('[WhatsApp Service] Contact found:', {
        contactId: contact.id,
        whatsappId: contact.whatsapp_id,
        syncStatus: contact.sync_status,
        metadata: contact.metadata,
        bridgeRoomId: contact.bridge_room_id
      });

      // Check if we need to handle bot invite
      if (!contact.bridge_room_id && contact.metadata?.room_id) {
        console.log('[WhatsApp Service] No bridge room ID, attempting to handle bot invite');
        try {
          await matrixWhatsAppService.handleBotInvite(userId, contact.metadata.room_id);
          // Refresh contact after bot invite
          const { data: updatedContact } = await adminClient
            .from('whatsapp_contacts')
            .select('bridge_room_id')
            .eq('id', numericContactId)
            .single();
          
          if (updatedContact?.bridge_room_id) {
            contact.bridge_room_id = updatedContact.bridge_room_id;
            console.log('[WhatsApp Service] Bot invite handled, bridge room ID updated:', updatedContact.bridge_room_id);
          }
        } catch (inviteError) {
          console.error('[WhatsApp Service] Failed to handle bot invite:', inviteError);
        }
      }

      // Build query to fetch messages
      console.log('[WhatsApp Service] Building messages query');
      let query = adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', numericContactId)
        .order('timestamp', { ascending: false });

      if (limit) {
        console.log('[WhatsApp Service] Adding limit:', limit);
        query = query.limit(parseInt(limit, 10));
      }

      if (before) {
        console.log('[WhatsApp Service] Adding before timestamp filter:', before);
        query = query.lt('timestamp', before);
      }

      // Execute query
      const { data: messages, error: queryError } = await query;
      if (queryError) {
        console.error('[WhatsApp Service] Message query error:', queryError);
        throw queryError;
      }

      console.log(`[WhatsApp Service] Retrieved ${messages?.length || 0} messages:`, {
        firstMessageTimestamp: messages?.[0]?.timestamp,
        lastMessageTimestamp: messages?.[messages?.length - 1]?.timestamp,
        messageIds: messages?.map(m => m.id)
      });

      // If no messages found and we have a bridge room, force a sync
      if ((!messages || messages.length === 0) && contact.bridge_room_id) {
        console.log('[WhatsApp Service] No messages found, initiating forced sync');
        try {
          // Request sync
          const syncResult = await matrixWhatsAppService.syncMessages(userId, numericContactId);
          console.log('[WhatsApp Service] Sync initiated:', syncResult);

          // Wait for sync to complete with timeout
          await this.waitForSync(userId, numericContactId, 30000);
          console.log('[WhatsApp Service] Sync completed, retrying message fetch');

          // Retry message fetch
          const { data: syncedMessages, error: syncError } = await query;
          if (syncError) {
            console.error('[WhatsApp Service] Post-sync query error:', syncError);
            throw syncError;
          }

          console.log('[WhatsApp Service] Post-sync messages retrieved:', {
            count: syncedMessages?.length || 0
          });

          return syncedMessages || [];
        } catch (syncError) {
          console.error('[WhatsApp Service] Forced sync failed:', syncError);
          throw new Error(`Failed to sync messages: ${syncError.message}`);
        }
      }

      return messages || [];
    } catch (error) {
      console.error('[WhatsApp Service] Error in getMessages:', error);
      console.error('[WhatsApp Service] Stack:', error.stack);
      throw error;
    } finally {
      this.syncLocks.delete(lockKey);
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