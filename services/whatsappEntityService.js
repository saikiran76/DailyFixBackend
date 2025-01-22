import { adminClient } from '../utils/supabase.js';
import { matrixWhatsAppService } from './matrixWhatsAppService.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';
import * as sdk from 'matrix-js-sdk';
import { getIO } from '../utils/socket.js';
import { createClient } from 'redis';
import { redisConfig } from '../config/redis.js';
import { redisClient } from './redisService.js';
import { logger } from '../utils/logger.js';

const pubClient = createClient(redisConfig);
await pubClient.connect();

const CACHE_KEYS = {
  CONTACTS: (userId) => `whatsapp:${userId}:contacts`,
  MESSAGES: (userId, contactId) => `whatsapp:${userId}:messages:${contactId}`,
  PRIORITIES: (userId, contactId) => `whatsapp:${userId}:priorities:${contactId}`
};

const CACHE_TTL = {
  CONTACTS: 300, // 5 minutes
  MESSAGES: 600, // 10 minutes
  PRIORITIES: 1800 // 30 minutes
};

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
    this.lockTimeouts = new Map();
    this.LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    this.lockPromises = new Map();
    this.contactSyncTimes = new Map();

    // Enhanced sync status constants
    this.SYNC_STATES = {
      PENDING: 'pending',
      APPROVED: 'approved',
      REJECTED: 'rejected'
    };
  }

  // Helper to clear lock and timeout
  _clearLock(lockKey) {
    this.syncLocks.delete(lockKey);
    const timeoutId = this.lockTimeouts.get(lockKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.lockTimeouts.delete(lockKey);
    }
  }

  // Helper to set lock with timeout
  _setLock(lockKey) {
    if (this.syncLocks.get(lockKey)) {
      return false;
    }

    this.syncLocks.set(lockKey, true);
    const timeoutId = setTimeout(() => {
      console.log(`[WhatsApp Service] Lock timeout for ${lockKey}`);
      this._clearLock(lockKey);
    }, this.LOCK_TIMEOUT);
    
    this.lockTimeouts.set(lockKey, timeoutId);
    return true;
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

  async acquireLock(lockKey) {
    while (this.syncLocks.get(lockKey)) {
      // Wait for existing lock to be released
      await new Promise(resolve => {
        const currentPromise = this.lockPromises.get(lockKey) || Promise.resolve();
        this.lockPromises.set(lockKey, currentPromise.then(resolve));
      });
    }
    this.syncLocks.set(lockKey, true);
  }

  releaseLock(lockKey) {
    this.syncLocks.delete(lockKey);
    const promise = this.lockPromises.get(lockKey);
    if (promise) {
      promise.then(() => this.lockPromises.delete(lockKey));
    }
  }

  async getContacts(userId, options = { forceSync: false }) {
    try {
      // Try cache first if not forcing sync
      if (!options.forceSync) {
        const cached = await redisClient.get(CACHE_KEYS.CONTACTS(userId));
        if (cached) {
          return JSON.parse(cached);
        }
      }

      // Get from database
      const { data: dbContacts, error: dbError } = await adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      if (dbError) throw dbError;

      // Start background sync if forced or no contacts
      if (options.forceSync || !dbContacts.length) {
        this.syncContacts(userId);
      }

      // Cache results
      await redisClient.set(
        CACHE_KEYS.CONTACTS(userId),
        JSON.stringify(dbContacts),
        'EX',
        CACHE_TTL.CONTACTS
      );

      return dbContacts;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching contacts:', error);
      throw error;
    }
  }

  async syncContacts(userId) {
    try {
      // Get Matrix client
      const client = await matrixWhatsAppService.getMatrixClient(userId);
      if (!client) {
        throw new Error('Matrix client not initialized');
      }

      // Get bridge room
      const bridgeRoom = await matrixWhatsAppService.getBridgeRoom(userId);
      if (!bridgeRoom) {
        throw new Error('Bridge room not found');
      }

      // Start sync process
      await matrixWhatsAppService.syncMessages(userId, bridgeRoom.roomId, {
        type: 'contacts',
        fullSync: true
      });

      return true;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error syncing contacts:', error);
      throw error;
    }
  }

  async getMessages(userId, contactId, options = { limit: 50, before: null }) {
    try {
      // Try cache first
      const cacheKey = CACHE_KEYS.MESSAGES(userId, contactId);
      const cached = await redisClient.get(cacheKey);
      
      if (cached) {
        const messages = JSON.parse(cached);
        // Filter based on options
        return messages.filter(msg => 
          (!options.before || msg.timestamp < options.before)
        ).slice(0, options.limit);
      }

      // Get from database
      const { data: messages, error } = await adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .limit(options.limit);

      if (error) throw error;

      // Cache results
      await redisClient.set(
        cacheKey,
        JSON.stringify(messages),
        'EX',
        CACHE_TTL.MESSAGES
      );

      // Start background sync
      this.syncMessages(userId, contactId);

      return messages;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching messages:', error);
      throw error;
    }
  }

  async syncMessages(userId, contactId) {
    try {
      await matrixWhatsAppService.syncMessages(userId, contactId, {
        type: 'messages',
        fullSync: false
      });
      return true;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error syncing messages:', error);
      throw error;
    }
  }

  async getPriorities(userId, contactId) {
    try {
      // Try cache first
      const cacheKey = CACHE_KEYS.PRIORITIES(userId, contactId);
      const cached = await redisClient.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      // Get from database
      const { data: priorities, error } = await adminClient
        .from('whatsapp_priorities')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Cache results
      await redisClient.set(
        cacheKey,
        JSON.stringify(priorities),
        'EX',
        CACHE_TTL.PRIORITIES
      );

      return priorities;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching priorities:', error);
      throw error;
    }
  }

  // Cache invalidation methods
  async invalidateContactCache(userId) {
    await redisClient.del(CACHE_KEYS.CONTACTS(userId));
  }

  async invalidateMessageCache(userId, contactId) {
    await redisClient.del(CACHE_KEYS.MESSAGES(userId, contactId));
  }

  async invalidatePriorityCache(userId, contactId) {
    await redisClient.del(CACHE_KEYS.PRIORITIES(userId, contactId));
  }

  async getLastContactSyncTime(userId) {
    return this.contactSyncTimes.get(userId);
  }

  async getLastMessage(room) {
    try {
      const events = room.getLiveTimeline().getEvents();
      if (events.length === 0) return null;

      // Find last message event
      const lastMessageEvent = events.reverse().find(event => 
        event.getType() === 'm.room.message' &&
        event.getSender() !== this.bridgeBotUserId
      );

      if (!lastMessageEvent) return null;

      return {
        content: lastMessageEvent.getContent(),
        sender: lastMessageEvent.getSender(),
        timestamp: lastMessageEvent.getTs(),
        eventId: lastMessageEvent.getId()
      };
    } catch (error) {
      console.error('Error getting last message:', error);
      return null;
    }
  }

  async updateContacts(userId, contacts) {
    try {
      // Batch update contacts in database
      const { error } = await this.adminClient
        .from('whatsapp_bridges')
        .upsert(
          contacts.map(contact => ({
            id: contact.id,
            user_id: userId,
            matrix_room_id: contact.id,
            whatsapp_id: contact.whatsappId,
            display_name: contact.displayName,
            last_message: contact.lastMessage,
            unread_count: contact.unreadCount,
            updated_at: new Date().toISOString()
          })),
          { onConflict: 'matrix_room_id' }
        );

      if (error) {
        throw error;
      }

      // Emit update event
      const io = getIO();
      if (io) {
        io.to(userId).emit('contacts:updated', {
          userId,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      console.error(`[WhatsApp Sync] Error updating contacts for user ${userId}:`, error);
      throw error;
    }
  }

  async getMatrixClientWithRetry(userId, maxRetries = 3) {
    let attempts = 0;
    let lastError;

    while (attempts < maxRetries) {
      try {
        const client = await this.getMatrixClient(userId);
        if (client?.clientRunning) {
          return client;
        }
        
        if (client && !client.clientRunning) {
          await client.startClient({ initialSyncLimit: 10 });
          return client;
        }
      } catch (error) {
        lastError = error;
        attempts++;
        if (attempts === maxRetries) break;
        
        // Exponential backoff
        await new Promise(resolve => 
          setTimeout(resolve, Math.min(1000 * Math.pow(2, attempts), 10000))
        );
      }
    }

    throw lastError || new Error('Failed to get Matrix client after retries');
  }

  async waitForSync(matrixClient) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Matrix sync timeout'));
      }, 30000);

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
          reject(new Error(`Sync failed with state: ${state}`));
        }
      });

      checkSync();
    });
  }

  // Add method to force sync
  async forceSyncContacts(userId) {
    console.log('[WhatsApp Service] Force syncing contacts for user:', userId);
    return this.getContacts(userId, true);
  }

  // Reset sync status (useful for testing or error recovery)
  resetSyncStatus(userId) {
    this.initialSyncComplete.delete(userId);
    // Clear all locks for this user
    for (const [lockKey, timeoutId] of this.lockTimeouts.entries()) {
      if (lockKey.startsWith(`${userId}-`)) {
        this._clearLock(lockKey);
      }
    }
  }

  async requestSync(userId, contactId) {
    try {
      // Get most recently updated contact record
      const { data: contacts, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('id', contactId)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (contactError || !contacts || contacts.length === 0) {
        console.error('[WhatsApp Service] Contact not found:', contactError);
        throw new Error('Contact not found');
      }

      const contact = contacts[0];

      // Get Matrix client
      const matrixClient = await this.getMatrixClient(userId);
      if (!matrixClient) {
        throw new Error('Matrix client not initialized');
      }

      // Check if room exists in contact metadata
      if (!contact.metadata?.room_id) {
        throw new Error('No room ID found in contact metadata');
      }

      // Get room and check memberships
      const room = matrixClient.getRoom(contact.metadata.room_id);
      if (!room) {
        throw new Error('Room not found');
      }

      const userMember = room.getMember(matrixClient.getUserId());

      // Initialize sync status
      await this.updateSyncStatus(userId, contactId, 'pending', {
        current: 0,
        total: 100,
        status: 'initializing',
        metadata: {
          user_membership: userMember?.membership || 'none'
        }
      });

      // Request sync using Matrix's native sync
      const syncResult = await matrixWhatsAppService.syncMessages(userId, contactId);

      // Update final status based on sync result
      const finalStatus = syncResult.status === 'success' ? 'approved' : 'rejected';
      await this.updateSyncStatus(userId, contactId, finalStatus, {
        current: 100,
        total: 100,
        status: finalStatus,
        metadata: {
          user_membership: userMember?.membership || 'none'
        }
      });

      return {
        status: 'success',
        data: {
          sync_status: finalStatus,
          message: `Sync ${finalStatus === 'approved' ? 'completed' : 'failed'}`,
          details: syncResult
        }
      };
    } catch (error) {
      console.error('[WhatsApp Service] Error in requestSync:', error);
      throw error;
    }
  }

  async waitForSync(userId, contactId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const CHECK_INTERVAL = 1000; // Check every second
      
      const checkSync = async () => {
        try {
          const { data: contact } = await adminClient
            .from('whatsapp_contacts')
            .select('sync_status, metadata')
            .eq('user_id', userId)
            .eq('id', contactId)
            .single();

          if (!contact) {
            reject(new Error('Contact not found'));
            return;
          }

          switch (contact.sync_status) {
            case this.SYNC_STATES.APPROVED:
              resolve({
                status: 'success',
                contact
              });
              break;
            case this.SYNC_STATES.REJECTED:
              reject(new Error(`Sync ${contact.sync_status}: ${contact.metadata?.error || 'Unknown error'}`));
              break;
            default:
              if (Date.now() - startTime > timeout) {
                reject(new Error('Sync timeout'));
              } else {
                setTimeout(checkSync, CHECK_INTERVAL);
              }
          }
        } catch (error) {
          reject(error);
        }
      };

      checkSync();
    });
  }

  async updateSyncStatus(userId, contactId, status, progress = null) {
    try {
      console.log(`[WhatsApp Service] Updating sync status for contact ${contactId}: ${status}`);
      
      // Validate status against allowed values
      if (!Object.values(this.SYNC_STATES).includes(status)) {
        throw new Error(`Invalid sync status: ${status}. Must be one of: pending, approved, rejected`);
      }

      // Get existing contact data first
      const { data: existingContact, error: fetchError } = await adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('id', contactId)
        .eq('user_id', userId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      const updateData = {
        sync_status: status,
        metadata: {
          ...existingContact?.metadata,
          last_sync_attempt: new Date().toISOString(),
          sync_history: [
            ...(existingContact?.metadata?.sync_history || []),
            {
              status,
              timestamp: new Date().toISOString(),
              progress: progress ? {
                current: progress.current,
                total: progress.total,
                percentage: Math.round((progress.current / progress.total) * 100),
                status: progress.status
              } : null
            }
          ].slice(-5) // Keep last 5 sync attempts
        },
        updated_at: new Date().toISOString()
      };

      const { data, error } = await adminClient
        .from('whatsapp_contacts')
        .update(updateData)
        .eq('user_id', userId)
        .eq('id', contactId)
        .select()
        .single();

      if (error) throw error;

      // Emit status update via Socket.IO
      const io = getIO();
      if (io) {
        io.to(`user:${userId}`).emit('whatsapp:sync_status', {
          contactId,
          status,
          progress,
          timestamp: new Date().toISOString()
        });
      }

      return data;
    } catch (error) {
      console.error('[WhatsApp Service] Error updating sync status:', error);
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

  async updateContactStatus(userId, contactId, status, error = null) {
    try {
      const { data, error: dbError } = await adminClient
        .from('whatsapp_contacts')
        .update({
          sync_status: status,
          metadata: {
            error: error,
            last_invite_attempt: new Date().toISOString()
          }
        })
        .eq('user_id', userId)
        .eq('id', contactId);

      if (dbError) throw dbError;
      
      // Emit status update
      const io = getIO();
      if (io) {
        io.to(`user:${userId}`).emit('whatsapp:sync_status', {
          contactId,
          status,
          error
        });
      }
    } catch (error) {
      console.error('[WhatsApp Service] Error updating contact status:', error);
    }
  }

  async startWhatsAppSyncJob() {
    try {
      // Initialize sync job state
      this.syncJobRunning = false;
      this.lastSyncTime = null;
      this.syncErrors = new Map();
      this.syncInterval = 5 * 60 * 1000; // 5 minutes

      // Start periodic sync job
      this.syncJobInterval = setInterval(async () => {
        if (this.syncJobRunning) {
          console.log('[WhatsApp Sync] Previous sync job still running, skipping...');
          return;
        }

        this.syncJobRunning = true;
        try {
          // Get all users with WhatsApp bridges
          const { data: users, error: userError } = await this.adminClient
            .from('accounts')
            .select('user_id')
            .eq('platform', 'matrix')
            .not('credentials', 'is', null);

          if (userError) {
            throw new Error(`Failed to fetch users: ${userError.message}`);
          }

          // Process each user's WhatsApp contacts
          for (const user of users) {
            try {
              const userId = user.user_id;
              const lockKey = `sync:${userId}`;

              // Skip if locked
              if (this.syncLocks.get(lockKey)) {
                console.log(`[WhatsApp Sync] Sync locked for user ${userId}, skipping...`);
                continue;
              }

              // Set lock with timeout
              this._setLock(lockKey);

              try {
                // Get Matrix client
                const matrixClient = await this.getMatrixClient(userId);
                if (!matrixClient) {
                  console.error(`[WhatsApp Sync] No Matrix client for user ${userId}`);
                  continue;
                }

                // Sync WhatsApp contacts
                await this.syncContacts(userId);

                // Update last sync time
                this.contactSyncTimes.set(userId, Date.now());

              } catch (error) {
                console.error(`[WhatsApp Sync] Error syncing user ${userId}:`, error);
                this.syncErrors.set(userId, {
                  error: error.message,
                  timestamp: Date.now()
                });
              } finally {
                // Clear lock
                this._clearLock(lockKey);
              }
            } catch (userError) {
              console.error('[WhatsApp Sync] Error processing user:', userError);
            }
          }

          this.lastSyncTime = Date.now();
          console.log('[WhatsApp Sync] Sync job completed');

        } catch (error) {
          console.error('[WhatsApp Sync] Sync job error:', error);
        } finally {
          this.syncJobRunning = false;
        }
      }, this.syncInterval);

      console.log('[WhatsApp Sync] Sync job service started');
      return true;
    } catch (error) {
      console.error('[WhatsApp Sync] Failed to start sync job service:', error);
      throw error;
    }
  }

  async cleanup() {
    if (this.syncJobInterval) {
      clearInterval(this.syncJobInterval);
    }
    this.syncLocks.clear();
    this.lockTimeouts.forEach(clearTimeout);
    this.lockTimeouts.clear();
  }
}

export const whatsappEntityService = new WhatsAppEntityService();
export const startWhatsAppSyncJob = () => whatsappEntityService.startWhatsAppSyncJob();

// whatsappEntityService.getCachedContacts('3ef66b64-4a8b-460f-b70f-8c0ddd8e73ff').then(contacts => {
//   console.log('[WhatsAppEntityService] Fetched cached contacts:', contacts);
// }).catch(error => {
//   console.error('[WhatsAppEntityService] Error fetching cached contacts:', error);
// });

export async function getContacts(userId) {
  const CACHE_KEY = `whatsapp:${userId}:contacts`;
  const CACHE_DURATION = 300; // 5 minutes

  try {
    // Check cache first
    const cachedContacts = await pubClient.get(CACHE_KEY);
    if (cachedContacts) {
      const parsed = JSON.parse(cachedContacts);
      // Return cached data if it's less than 5 minutes old
      if (Date.now() - parsed.timestamp < CACHE_DURATION * 1000) {
        return parsed.contacts;
      }
    }

    // Fetch fresh contacts
    const contacts = await fetchContactsFromMatrix(userId);
    
    // Cache with metadata
    const contactData = {
      contacts,
      timestamp: Date.now(),
      count: contacts.length
    };

    // Set cache with expiration
    await pubClient.set(
      CACHE_KEY,
      JSON.stringify(contactData),
      'EX',
      CACHE_DURATION
    );

    // Set a secondary index for quick contact count
    await pubClient.set(
      `whatsapp:${userId}:contact_count`,
      contacts.length,
      'EX',
      CACHE_DURATION
    );

    return contacts;
  } catch (error) {
    console.error('Failed to fetch contacts:', error);
    // Return cached data if available, even if expired
    const staleCache = await pubClient.get(CACHE_KEY);
    if (staleCache) {
      return JSON.parse(staleCache).contacts;
    }
    throw error;
  }
}

export async function updateContact(userId, contactId, updates) {
  try {
    const result = await updateContactInMatrix(userId, contactId, updates);
    
    // Invalidate contact cache
    await pubClient.del(`whatsapp:${userId}:contacts`);
    await pubClient.del(`whatsapp:${userId}:contact_count`);
    
    return result;
  } catch (error) {
    console.error('Failed to update contact:', error);
    throw error;
  }
}

// Concurrency control for sync operations
const syncLocks = new Map();
const LOCK_TIMEOUT = 30000; // 30 seconds

const acquireSyncLock = async (userId, entityId) => {
  const lockKey = `${userId}:${entityId}`;
  
  if (syncLocks.has(lockKey)) {
    const { timestamp, operation } = syncLocks.get(lockKey);
    if (Date.now() - timestamp < LOCK_TIMEOUT) {
      throw new Error(`Sync operation "${operation}" already in progress`);
    }
  }
  
  syncLocks.set(lockKey, {
    timestamp: Date.now(),
    operation: 'sync'
  });
  
  return {
    release: () => syncLocks.delete(lockKey)
  };
};

// Enhanced error handling for WhatsApp operations
const handleWhatsAppError = async (error, context) => {
  const errorType = getErrorType(error);
  
  switch (errorType) {
    case ERROR_TYPES.RATE_LIMIT:
      await handleRateLimitError(context);
      break;
    case ERROR_TYPES.AUTH:
      await handleAuthError(context);
      break;
    case ERROR_TYPES.NETWORK:
      await handleNetworkError(context);
      break;
    default:
      logger.error(`WhatsApp operation failed: ${error.message}`, context);
      throw error;
  }
};

// Enhance existing functions with concurrency control
const enhanceWithConcurrency = (fn) => {
  return async function (...args) {
    const [userId, entityId] = args;
    const lock = await acquireSyncLock(userId, entityId);
    
    try {
      return await fn.apply(this, args);
    } finally {
      lock.release();
    }
  };
};

// Apply enhancements to existing functions while preserving their signatures
const originalFunctions = {
  syncContacts: whatsappEntityService.syncContacts,
  syncMessages: whatsappEntityService.syncMessages
};

whatsappEntityService.syncContacts = enhanceWithConcurrency(originalFunctions.syncContacts);
whatsappEntityService.syncMessages = enhanceWithConcurrency(originalFunctions.syncMessages);

async function getRoomsWithRetry(matrixClient, maxRetries = 3) {
  let attempts = 0;
  let lastError;

  while (attempts < maxRetries) {
    try {
      const rooms = matrixClient.getRooms() || [];
      return rooms;
    } catch (error) {
      lastError = error;
      attempts++;
      if (attempts === maxRetries) break;
      
      await new Promise(resolve => 
        setTimeout(resolve, Math.min(1000 * Math.pow(2, attempts), 10000))
      );
    }
  }

  throw lastError || new Error('Failed to get rooms after retries');
}

async function processContactsWithRetry(whatsappRooms, maxRetries = 3) {
  const contacts = [];
  const errors = [];

  for (const room of whatsappRooms) {
    let attempts = 0;
    let processed = false;

    while (attempts < maxRetries && !processed) {
      try {
        const whatsappId = this._extractWhatsAppId(room);
        if (!whatsappId) continue;

        const contact = await this._buildContactObject(room, whatsappId);
        contacts.push(contact);
        processed = true;
      } catch (error) {
        attempts++;
        if (attempts === maxRetries) {
          errors.push({
            roomId: room.roomId,
            error: error.message
          });
        } else {
          await new Promise(resolve => 
            setTimeout(resolve, Math.min(1000 * Math.pow(2, attempts), 10000))
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    logger.warn('[WhatsApp Service] Some contacts failed to process:', { errors });
  }

  return contacts;
}

async function _buildContactObject(room, whatsappId) {
  const contact = {
    whatsapp_id: whatsappId,
    display_name: room.name,
    room_id: room.roomId,
    is_group: room.isGroup,
    last_message: null,
    unread_count: 0,
    updated_at: new Date().toISOString()
  };

  try {
    // Get latest message with error handling
    const timeline = room.timeline;
    if (timeline?.length > 0) {
      const lastMsg = timeline[timeline.length - 1];
      const content = lastMsg.getContent();
      
      contact.last_message = content.body;
      contact.last_message_at = new Date(lastMsg.getTs()).toISOString();
      
      // Get unread count
      const readUpToEventId = room.getEventReadUpTo(this.userId);
      contact.unread_count = timeline
        .filter(event => event.getId() > readUpToEventId)
        .length;
    }
  } catch (error) {
    logger.warn('[WhatsApp Service] Error getting message details:', {
      roomId: room.roomId,
      error: error.message
    });
  }

  return contact;
}

async function updateContactsWithRetry(userId, contacts, maxRetries = 3) {
  let attempts = 0;
  let lastError;

  while (attempts < maxRetries) {
    try {
      await this._updateContacts(userId, contacts);
      return;
    } catch (error) {
      lastError = error;
      attempts++;
      if (attempts === maxRetries) break;
      
      await new Promise(resolve => 
        setTimeout(resolve, Math.min(1000 * Math.pow(2, attempts), 10000))
      );
    }
  }

  throw lastError || new Error('Failed to update contacts after retries');
}