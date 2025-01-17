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
    this.adminClient = adminClient; // Store adminClient reference
    this.syncLocks = new Map(); // Add sync lock tracking
    this.whatsappRooms = [];
    this.skippedRooms = [];
    this.failedContacts = [];
    this.extractWhatsAppId = this.extractWhatsAppId.bind(this);
    this.initialSyncComplete = new Map(); // Track if initial sync is done for each user
    this.bridgeBotUserId = process.env.BRIDGE_BOT_USER_ID;
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
      if (matrixClient?.clientRunning) {
        return matrixClient;
      }

      // Get Matrix account from database using adminClient
      const { data: matrixAccount, error: accountError } = await this.adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (accountError || !matrixAccount?.credentials) {
        console.error('[WhatsApp Service] Matrix account fetch error:', accountError);
        return null;
      }

      // Validate required credentials
      const { homeserver, accessToken, userId: matrixUserId } = matrixAccount.credentials;
      if (!homeserver || !accessToken || !matrixUserId) {
        console.error('[WhatsApp Service] Invalid Matrix credentials:', {
          hasHomeserver: !!homeserver,
          hasAccessToken: !!accessToken,
          hasUserId: !!matrixUserId
        });
        return null;
      }

      // Create Matrix client with correct credentials
      matrixClient = sdk.createClient({
        baseUrl: homeserver,
        accessToken: accessToken,
        userId: matrixUserId,
        timeoutMs: 30000,
        useAuthorizationHeader: true
      });

      // Initialize client
      try {
        console.log('[WhatsApp Service] Starting Matrix client...');
        await matrixClient.startClient({
          initialSyncLimit: 10
        });

        // Wait for initial sync
        await new Promise((resolve, reject) => {
          const syncTimeout = setTimeout(() => {
            reject(new Error('Matrix sync timeout'));
          }, 30000);

          const checkSync = () => {
            if (matrixClient.isInitialSyncComplete()) {
              clearTimeout(syncTimeout);
              resolve();
              return;
            }
            setTimeout(checkSync, 1000);
          };

          matrixClient.once('sync', (state) => {
            if (state === 'PREPARED') {
              clearTimeout(syncTimeout);
              resolve();
            } else if (state === 'ERROR') {
              clearTimeout(syncTimeout);
              reject(new Error(`Sync failed with state: ${state}`));
            }
          });

          checkSync();
        });

        // Store initialized client
        const clientStored = matrixWhatsAppService.setMatrixClient(userId, matrixClient);
        if (!clientStored) {
          console.error('[WhatsApp Service] Failed to store Matrix client');
          if (matrixClient?.stopClient) {
            matrixClient.stopClient();
          }
          return null;
        }

        console.log('[WhatsApp Service] Matrix client successfully initialized and stored');
        return matrixClient;

      } catch (initError) {
        console.error('[WhatsApp Service] Matrix client initialization error:', initError);
        // Cleanup on initialization failure
        if (matrixClient?.stopClient) {
          matrixClient.stopClient();
        }
        return null;
      }
    } catch (error) {
      console.error('[WhatsApp Service] Error in getMatrixClient:', error);
      return null;
    }
  }

  async getContacts(userId, forceSync = false) {
    const lockKey = `contacts-${userId}`;
    if (this.syncLocks.get(lockKey)) {
      console.log('[WhatsApp Service] Sync already in progress for user:', userId);
      return this.getCachedContacts(userId);
    }

    try {
      // Check if initial sync is already done and not forcing
      if (!forceSync && this.initialSyncComplete.get(userId)) {
        return this.getCachedContacts(userId);
      }

      this.syncLocks.set(lockKey, true);
      console.log('[WhatsApp Service] Starting contact sync for user:', userId);

      // Get Matrix client with initialization
      const matrixClient = await this.getMatrixClient(userId);
      if (!matrixClient) {
        console.error('[WhatsApp Service] Failed to initialize Matrix client');
        return this.getCachedContacts(userId);
      }

      // Use a reasonable timeout (2 minutes)
      const syncTimeout = 2 * 60 * 1000;
      const syncResult = await Promise.race([
        this.syncContacts(userId, matrixClient),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Contact sync timeout')), syncTimeout)
        )
      ]);

      // Mark sync as complete only on success
      this.initialSyncComplete.set(userId, true);
      return syncResult;
    } catch (error) {
      console.error('[WhatsApp Service] Error in getContacts:', error);
      // On error, clear sync complete flag to allow retry
      this.initialSyncComplete.delete(userId);
      // Return cached contacts on error
      return this.getCachedContacts(userId);
    } finally {
      this.syncLocks.delete(lockKey);
    }
  }

  async getCachedContacts(userId) {
    console.log('[WhatsApp Service] Using cached contacts for user:', userId);
    const { data: contacts, error } = await adminClient
      .from('whatsapp_contacts')
      .select('*')
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false });

    if (error) throw error;
    return contacts || [];
  }

  async syncContacts(userId, matrixClient) {
    try {
      // Get all rooms
      const rooms = matrixClient.getRooms();
      console.log(`[WhatsApp Service] Found ${rooms.length} rooms`);

      // Get existing contacts
      const { data: existingContacts } = await adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('user_id', userId);

      const contactMap = new Map(existingContacts?.map(c => [c.whatsapp_id, c]) || []);
      const updatedContacts = [];

      // Process each room
      for (const room of rooms) {
        try {
          const whatsappId = this.extractWhatsAppId({
            name: room.name,
            topic: room.topic,
            state_events: room.currentState.getStateEvents('uk.half-shot.bridge'),
            is_group: room.getJoinedMembers().length > 2
          });

          if (!whatsappId) continue;

          const contactData = {
            user_id: userId,
            whatsapp_id: whatsappId,
            display_name: room.name,
            metadata: {
              room_id: room.roomId,
              member_count: room.getJoinedMembers().length
            },
            last_message_at: new Date().toISOString()
          };

          const existing = contactMap.get(whatsappId);
          if (existing) {
            // Update existing contact
            const { error } = await adminClient
              .from('whatsapp_contacts')
              .update(contactData)
              .eq('id', existing.id);

            if (!error) updatedContacts.push({ ...existing, ...contactData });
          } else {
            // Insert new contact
            const { data, error } = await adminClient
              .from('whatsapp_contacts')
              .insert(contactData)
              .select()
              .single();

            if (!error) updatedContacts.push(data);
          }
        } catch (roomError) {
          console.error('[WhatsApp Service] Error processing room:', roomError);
          // Continue with other rooms
        }
      }

      return updatedContacts;
    } catch (error) {
      console.error('[WhatsApp Service] Error in syncContacts:', error);
      throw error;
    }
  }

  // Add method to force sync
  async forceSyncContacts(userId) {
    console.log('[WhatsApp Service] Force syncing contacts for user:', userId);
    return this.getContacts(userId, true);
  }

  // Reset sync status (useful for testing or error recovery)
  resetSyncStatus(userId) {
    this.initialSyncComplete.delete(userId);
    this.syncLocks.delete(userId);
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

      // Get and validate Matrix client first
      const matrixClient = matrixWhatsAppService.getMatrixClient(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Ensure client is started and synced
      if (!matrixClient.clientRunning) {
        console.log('[WhatsApp Service] Starting Matrix client...');
        await matrixClient.startClient({
          initialSyncLimit: 10
        });
      }

      // Wait for initial sync with timeout
      await new Promise((resolve, reject) => {
        const syncTimeout = setTimeout(() => {
          reject(new Error('Matrix sync timeout'));
        }, 30000);

        if (matrixClient.isInitialSyncComplete()) {
          clearTimeout(syncTimeout);
          resolve();
        } else {
          matrixClient.once('sync', (state) => {
            clearTimeout(syncTimeout);
            if (state === 'PREPARED') {
              resolve();
            } else {
              reject(new Error(`Sync failed with state: ${state}`));
            }
          });
        }
      });

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

      // Validate bridge room and bot status
      if (!contact.bridge_room_id) {
        console.log('[WhatsApp Service] No bridge room found, checking room status...');
        const roomId = contact.metadata?.room_id;
        if (!roomId) {
          throw new Error('No room ID found for contact');
        }

        const room = await matrixClient.getRoom(roomId);
        if (!room) {
          throw new Error('Room not found');
        }

        // Check if bridge bot is in the room
        const bridgeBotMember = room.getMember(this.bridgeBotUserId);
        if (!bridgeBotMember) {
          console.log('[WhatsApp Service] Bridge bot not found in room, attempting to invite...');
          await this.inviteBridgeBot(userId, contact);
          throw new Error('Bridge bot not in room - invitation sent');
        }

        // Update contact with bridge room ID if available
        const bridgeRoomId = room.roomId;
        if (bridgeRoomId) {
          await this.updateContact(userId, numericContactId, {
            bridge_room_id: bridgeRoomId
          });
          contact.bridge_room_id = bridgeRoomId;
        }
      }

      // Get messages with improved error handling
      try {
        const messages = await this._fetchMessagesFromRoom(
          matrixClient,
          contact.bridge_room_id,
          limit,
          before
        );
        
        if (!messages || messages.length === 0) {
          console.log('[WhatsApp Service] No messages found, triggering sync...');
          await this.requestSync(userId, numericContactId);
        }
        
        return messages || [];
      } catch (error) {
        console.error('[WhatsApp Service] Error fetching messages:', error);
        throw new Error(`Failed to fetch messages: ${error.message}`);
      }
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

  async _fetchMessagesFromRoom(matrixClient, roomId, limit = 50, before = null) {
    if (!roomId) {
      throw new Error('Room ID is required');
    }

    const room = matrixClient.getRoom(roomId);
    if (!room) {
      throw new Error('Room not found');
    }

    // Get timeline events
    let timelineEvents = room.timeline || [];
    
    // Filter for message events only
    timelineEvents = timelineEvents.filter(event => {
      return event.getType() === 'm.room.message' &&
             event.event.content?.msgtype === 'm.text';
    });

    // Apply before filter if specified
    if (before) {
      timelineEvents = timelineEvents.filter(event => {
        return event.getTs() < before;
      });
    }

    // Sort by timestamp descending
    timelineEvents.sort((a, b) => b.getTs() - a.getTs());

    // Apply limit
    if (limit) {
      timelineEvents = timelineEvents.slice(0, limit);
    }

    // Transform to message format
    return timelineEvents.map(event => ({
      id: event.getId(),
      content: event.getContent().body,
      timestamp: event.getTs(),
      sender: event.getSender(),
      type: 'message'
    }));
  }
}

export const whatsappEntityService = new WhatsAppEntityService(); 