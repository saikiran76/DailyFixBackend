import { adminClient } from '../utils/supabase.js';
import { matrixWhatsAppService } from './matrixWhatsAppService.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';
import * as sdk from 'matrix-js-sdk';
import { getIO } from '../utils/socket.js';
import { redisService } from '../utils/redis.js';
import { logger } from '../utils/logger.js';
import Redlock from 'redlock';
import { DistributedLock } from '../utils/lockManager.js';
import { lockService } from './lockService.js';
import { APIError } from '../middleware/errorHandler.js';

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
    this.waitForSync = this.waitForSync.bind(this); // Bind waitForSync
    this.initialSyncComplete = new Map(); // Track if initial sync is done for each user
    this.bridgeBotUserId = process.env.BRIDGE_BOT_USER_ID || '@whatsappbot:example-mtbr.duckdns.org';
    this.lockTimeouts = new Map();
    this.LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    this.lockPromises = new Map();
    this.contactSyncTimes = new Map();
    this.syncInProgress = new Map();
    this.SYNC_TIMEOUT = 30000; // 30 seconds timeout for sync

    this.initLockManager = async () => {
      try {
        await lockService.initialize();
        logger.info('[WhatsApp Entity] Lock service initialized');
      } catch (error) {
        logger.error('[WhatsApp Entity] Lock service initialization failed:', error);
      }
    };

    // Initialize Redlock with Redis client
    try {
      this.redlock = new Redlock(
        [redisService.pubClient], // Use pubClient from the redisService service
        {
          driftFactor: 0.01,
          retryCount: 3,
          retryDelay: 200,
          retryJitter: 200
        }
      );

      this.redlock.on('error', (error) => {
        logger.error('[WhatsApp Entity] Redlock error:', error);
      });

      logger.info('[WhatsApp Entity] Redlock initialized successfully');
    } catch (error) {
      logger.error('[WhatsApp Entity] Failed to initialize Redlock:', error);
      this.redlock = null;
    }

    // Enhanced sync states with progress tracking
    this.SYNC_STATES = {
      PENDING: {
        value: 'pending',
        allowedTransitions: ['approved', 'rejected']
      },
      APPROVED: {
        value: 'approved',
        allowedTransitions: ['pending']
      },
      REJECTED: {
        value: 'rejected',
        allowedTransitions: ['pending']
      }
    };

    this.cache = {
      contacts: new Map(),
      messages: new Map(),
      syncStates: new Map()
    };

    this.cacheConfig = {
      contacts: {
        ttl: 3600000, // 1 hour
        staleWhileRevalidate: 300000 // 5 minutes
      },
      messages: {
        ttl: 1800000, // 30 minutes
        staleWhileRevalidate: 300000 // 5 minutes
      },
      syncStates: {
        ttl: 300000, // 5 minutes
        staleWhileRevalidate: 60000 // 1 minute
      }
    };

    // Background revalidation queue
    this.revalidationQueue = new Map();
    this.MAX_QUEUE_SIZE = 1000;

    // Add rate limiting configuration
    this.syncRateLimit = {
      windowMs: 60000, // 1 minute
      maxRequests: 30, // 30 requests per minute
      current: new Map(),
      resetTime: new Map()
    };

    // Start cache maintenance
    this.startCacheMaintenance();

    // Bind methods
    this.getMatrixClientWithRetry = this.getMatrixClientWithRetry.bind(this);
    this.getMatrixClient = this.getMatrixClient.bind(this);
    this.waitForSync = this.waitForSync.bind(this);
    this.syncMessages = this.syncMessages.bind(this);
  }

  async withEntityLock(resource, operation) {
    return lockService.withLock(
      `whatsapp:${resource}`,
      operation,
      60000 // 1 minute timeout
    );
  }

  async startBackgroundSync(userId, contactId) {
    try {
      // Check if sync is already in progress
      if (this.syncInProgress.get(`${userId}:${contactId}`)) {
        throw new APIError('Sync already in progress', 409);
      }

      this.syncInProgress.set(`${userId}:${contactId}`, true);

      try {
        await this.syncMessages(userId, contactId);
      } finally {
        this.syncInProgress.delete(`${userId}:${contactId}`);
      }
    } catch (error) {
      logger.error('[WhatsApp Entity] Background sync failed:', {
        userId,
        contactId,
        error: error.message,
        stack: error.stack
      });
      throw error instanceof APIError ? error : new APIError('Failed to start sync', 500, error.message);
    }
  }

  startCacheMaintenance() {
    // Cleanup expired cache entries
    setInterval(() => this.cleanupCache(), 60000); // Every minute

    // Process revalidation queue
    setInterval(() => this.processRevalidationQueue(), 5000); // Every 5 seconds
  }

  async cleanupCache() {
    const now = Date.now();

    for (const [type, cache] of Object.entries(this.cache)) {
      for (const [key, entry] of cache.entries()) {
        if (now > entry.expiresAt) {
          cache.delete(key);
        }
      }
    }
  }

  async processRevalidationQueue() {
    const now = Date.now();
    const processing = new Set();

    for (const [key, task] of this.revalidationQueue.entries()) {
      if (now >= task.executeAt && !processing.has(key)) {
        processing.add(key);
        this.revalidationQueue.delete(key);

        // Execute revalidation in background
        this.executeRevalidation(key, task).catch(error => {
          logger.error('[WhatsApp Entity] Revalidation failed:', {
            key,
            error: error.message
          });
        });
      }
    }
  }

  async executeRevalidation(key, task) {
    try {
      const freshData = await task.fetchFn();
      
      // Update cache with fresh data
      const cacheEntry = {
        data: freshData,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + this.cacheConfig[task.type].ttl
      };

      this.cache[task.type].set(key, cacheEntry);

      logger.info('[WhatsApp Entity] Revalidation successful:', {
        key,
        type: task.type
      });
    } catch (error) {
      // On error, extend stale data lifetime
      const existingEntry = this.cache[task.type].get(key);
      if (existingEntry) {
        existingEntry.expiresAt += this.cacheConfig[task.type].staleWhileRevalidate;
        this.cache[task.type].set(key, existingEntry);
      }

      throw error;
    }
  }

  scheduleRevalidation(key, type, fetchFn) {
    // Don't schedule if queue is full
    if (this.revalidationQueue.size >= this.MAX_QUEUE_SIZE) {
      logger.warn('[WhatsApp Entity] Revalidation queue full:', { key, type });
      return;
    }

    this.revalidationQueue.set(key, {
      type,
      fetchFn,
      executeAt: Date.now() + Math.random() * 5000 // Spread load
    });
  }

  async getFromCache(key, type, fetchFn) {
    const cache = this.cache[type];
    const config = this.cacheConfig[type];
    const now = Date.now();

    // Check cache
    const cached = cache.get(key);
    if (cached) {
      // If within TTL, return immediately
      if (now < cached.expiresAt) {
        return cached.data;
      }

      // If within stale window, schedule revalidation and return stale
      if (now < cached.expiresAt + config.staleWhileRevalidate) {
        this.scheduleRevalidation(key, type, fetchFn);
        return cached.data;
      }
    }

    // Cache miss or expired, fetch fresh data
    const freshData = await fetchFn();
    
    cache.set(key, {
      data: freshData,
      fetchedAt: now,
      expiresAt: now + config.ttl
    });

    return freshData;
  }

  async getLastContactSyncTime(userId) {
    return this.contactSyncTimes.get(userId) || null;
  }

  async getContacts(userId, options = { forceSync: false }) {
    return this.withRetry(async () => {
      // Try cache first if not forcing sync
      if (!options.forceSync) {
        const cached = await this.getFromCache(
          `contacts:${userId}`,
          'contacts',
          async () => {
            const { data: contacts, error } = await this.adminClient
              .from('whatsapp_contacts')
              .select('*')
              .eq('user_id', userId)
              .order('updated_at', { ascending: false });

            if (error) throw error;
            return contacts;
          }
        );

        if (cached?.length > 0) {
          // Start background sync if needed
          const lastSyncTime = await this.getLastContactSyncTime(userId);
          const syncThreshold = 5 * 60 * 1000; // 5 minutes

          if (!lastSyncTime || Date.now() - lastSyncTime > syncThreshold) {
            this.startBackgroundSync(userId, null);
          }

          return cached;
        }
      }

      // No cache or force sync, perform full sync
      return this.syncContacts(userId);
    }, 3);
  }

  async syncContacts(userId) {
    return this.withEntityLock(`contacts:${userId}`, async () => {
      try {
        // Get Matrix client
        const client = await this.getMatrixClient(userId);
        if (!client) {
          throw new Error('Matrix client not available');
        }

        // Get WhatsApp rooms
        const rooms = await this.getWhatsAppRooms(client);
        
        // Process rooms in batches
        const contacts = [];
        const batchSize = 10;
        
        for (let i = 0; i < rooms.length; i += batchSize) {
          const batch = rooms.slice(i, i + batchSize);
          const batchContacts = await Promise.all(
            batch.map(room => this.processContactRoom(userId, room))
          );
          
          contacts.push(...batchContacts.filter(Boolean));

          // Update sync progress
          const progress = Math.min(100, Math.round((i + batchSize) / rooms.length * 100));
          await this.updateSyncProgress(userId, 'contacts', progress);
        }

        // Update database in batches
        const dbBatchSize = 50;
        for (let i = 0; i < contacts.length; i += dbBatchSize) {
          const batch = contacts.slice(i, i + dbBatchSize);
          await this.updateContactBatch(userId, batch);
        }

        // Update cache
        await this.invalidateCache('contacts', userId);
        
        // Update last sync time
        this.contactSyncTimes.set(userId, Date.now());

        return contacts;
      } catch (error) {
        logger.error('[WhatsApp Entity] Contact sync failed:', {
          userId,
          error: error.message
        });
        throw error;
      }
    });
  }

  async processContactRoom(userId, room) {
    try {
      const whatsappId = this.extractWhatsAppId(room);
      if (!whatsappId) return null;

      // Get last message
      const lastMessage = await this.getLastMessage(room);

      return {
        id: room.roomId,
        user_id: userId,
        whatsapp_id: whatsappId,
        display_name: room.name,
        is_group: room.isGroup,
        last_message: lastMessage?.content?.body,
        last_message_at: lastMessage ? new Date(lastMessage.timestamp).toISOString() : null,
        unread_count: this.getUnreadCount(room),
        metadata: {
          room_id: room.roomId,
          avatar_url: room.getAvatarUrl(),
          members: room.getJoinedMembers().length
        },
        updated_at: new Date().toISOString()
      };
    } catch (error) {
      logger.error('[WhatsApp Entity] Error processing contact room:', {
        userId,
        roomId: room.roomId,
        error: error.message
      });
      return null;
    }
  }

  async getContact(userId, contactId) {
    try {
      // Convert contactId to string for consistent handling
      const contactIdStr = String(contactId);
      
      // Query using contact_id for numeric IDs
      // const query = {
      //   text: 'SELECT * FROM whatsapp_contacts WHERE user_id = $1 AND contact_id = $2',
      //   values: [userId, contactId]
      // };

      const result = await this.adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('user_id', userId)
        .eq('id', parseInt(contactIdStr, 10));

      if (!result.data || result.data.length === 0) {
        throw new Error('Contact not found');
      }
      
      return result.data[0];
    } catch (error) {
      logger.error('[WhatsApp Entity] Contact fetch error:', {
        userId,
        contactId,
        error: error.message
      });
      throw new Error('Failed to fetch contact');
    }
  }

  async getMessages(userId, contactId, options = { page: 1, limit: 50 }) {
    try {
      // Validate contact exists
      const contact = await this.getContact(userId, contactId);
      if (!contact) {
        throw new APIError('Contact not found', 404);
      }

      // Get messages with pagination
      const { data: messages, error } = await this.adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .range(
          (options.page - 1) * options.limit,
          options.page * options.limit - 1
        );

      if (error) throw error;

      // If no messages found, trigger background sync
      if (!messages || messages.length === 0) {
        this.startBackgroundSync(userId, contactId).catch(error => {
          logger.error('[WhatsApp Entity] Background sync failed:', {
            userId,
            contactId,
            error: error.message
          });
        });
      }

      return messages || [];
    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching messages:', {
        userId,
        contactId,
        error: error.message
      });
      throw error instanceof APIError ? error : new APIError('Failed to fetch messages', 500, error.message);
    }
  }

  async syncMessages(userId, contactId) {
    const contact = await this.getContact(userId, contactId);
    
    try {
      // 1. Get Matrix client
      const client = await this.getMatrixClient(userId);
      
      // 2. Update sync status to pending first
      await this.updateSyncStatus(userId, contactId, {
        state: 'pending',
        progress: 10,
        details: 'Initializing Matrix client'
      });
      
      // 3. Check if client is already synced
      if (client.getSyncState() === 'PREPARED') {
        logger.info('[WhatsApp Entity] Matrix client already synced:', { userId, contactId });
      } else {
        // Wait for sync with timeout
        logger.info('[WhatsApp Entity] Waiting for client sync:', { userId, contactId });
        
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error('Matrix sync timeout'));
            }, 30000);

            const onSync = (state) => {
              logger.debug('[WhatsApp Entity] Matrix sync state:', {
                userId,
                contactId,
                state,
                roomCount: client.getRooms().length
              });

              if (state === 'PREPARED' || state === 'SYNCING') {
                cleanup();
                resolve();
              }
            };

            const cleanup = () => {
              clearTimeout(timeout);
              client.removeListener('sync', onSync);
            };

            client.on('sync', onSync);
          });
        } catch (syncError) {
          // On timeout, check if we're in SYNCING state - this is also acceptable
          if (client.getSyncState() === 'SYNCING') {
            logger.info('[WhatsApp Entity] Proceeding with SYNCING state:', { userId, contactId });
          } else {
            throw syncError;
          }
        }
      }

      // 4. Get or create room
      logger.info('[WhatsApp Entity] Getting room for contact:', { 
        userId, 
        contactId,
        existingRoomId: contact.metadata?.room_id 
      });

      const roomId = await this.getOrCreateRoomId(userId, contactId, client);
      
      // 5. Update sync status to show progress
      await this.updateSyncStatus(userId, contactId, {
        state: 'pending',
        progress: 40,
        details: 'Matrix client ready, starting message sync',
        room_id: roomId
      });

      // 6. Get room and validate
      const room = client.getRoom(roomId);
      if (!room) {
        throw new Error('Room not found after getting ID');
      }

      // 7. Fetch messages from room
      logger.info('[WhatsApp Entity] Fetching messages from room:', {
        userId,
        contactId,
        roomId
      });

      const messages = await this._fetchMessagesFromRoom(client, roomId);

      // 8. Update sync status for message processing
      await this.updateSyncStatus(userId, contactId, {
        state: 'pending',
        progress: 60,
        details: `Processing ${messages.length} messages`
      });

      // 9. Transform and save messages
      const messagesToSave = messages.map(msg => {
        // Map Matrix message types to WhatsApp message types
        let messageType = 'text';
        if (msg.type === 'm.image') messageType = 'image';
        else if (msg.type === 'm.video') messageType = 'video';
        else if (msg.type === 'm.audio') messageType = 'audio';
        else if (msg.type === 'm.file') messageType = 'document';
        else if (msg.type && msg.type.startsWith('m.')) messageType = 'media';

        return {
          user_id: userId,
          contact_id: contactId,
          message_id: msg.id,
          content: msg.content,
          sender_id: msg.sender,
          sender_name: room.getMember(msg.sender)?.name || msg.sender,
          message_type: messageType, // Now using validated message type
          metadata: {
            raw_event: msg.raw || {},
            room_id: roomId,
            media: msg.media,
            reaction_to: msg.metadata?.reaction_to,
            receipts: msg.metadata?.receipts
          },
          timestamp: new Date(msg.timestamp).toISOString(),
          is_read: false,
          created_at: new Date().toISOString()
        };
      });

      // 10. Save messages in batches
      const BATCH_SIZE = 50;
      for (let i = 0; i < messagesToSave.length; i += BATCH_SIZE) {
        const batch = messagesToSave.slice(i, i + BATCH_SIZE);
        
        logger.info('[WhatsApp Entity] Saving message batch:', {
          userId,
          contactId,
          batchSize: batch.length,
          progress: `${i + batch.length}/${messagesToSave.length}`
        });

        await this.updateMessageBatch(userId, contactId, batch);

        // Update progress
        const progress = Math.min(60 + Math.floor((i + batch.length) / messagesToSave.length * 30), 90);
        await this.updateSyncStatus(userId, contactId, {
          state: 'pending',
          progress,
          details: `Saved ${i + batch.length}/${messagesToSave.length} messages`
        });
      }

      // 11. Update contact's last message info
      if (messagesToSave.length > 0) {
        const lastMessage = messagesToSave[0]; // Messages are already sorted newest first
        await this.adminClient
          .from('whatsapp_contacts')
          .update({
            last_message: lastMessage.content,
            last_message_at: lastMessage.timestamp,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('id', contactId);

        logger.info('[WhatsApp Entity] Updated contact last message:', {
          userId,
          contactId,
          messageCount: messagesToSave.length
        });
      }

      // 12. Mark sync as complete
      await this.updateSyncStatus(userId, contactId, {
        state: 'approved',
        progress: 100,
        details: `Successfully synced ${messagesToSave.length} messages`,
        last_sync: new Date().toISOString()
      });

      logger.info('[WhatsApp Entity] Message sync completed:', {
        userId,
        contactId,
        messageCount: messagesToSave.length
      });

      return {
        status: 'success',
        messageCount: messagesToSave.length,
        roomId
      };

    } catch (error) {
      logger.error('[WhatsApp Entity] Sync failed:', {
        userId,
        contactId,
        error: error.message,
        stack: error.stack
      });

      // Update sync status with error
      await this.updateSyncStatus(userId, contactId, {
        state: 'pending', // Use pending instead of rejected to allow retries
        progress: 0,
        error: error.message,
        errorType: error.name === 'APIError' ? error.code : 'SYNC_ERROR',
        details: 'Sync failed: ' + error.message,
        retryAfter: new Date(Date.now() + 5 * 60000).toISOString() // 5 minutes
      });

      throw error;
    }
  }

  filterMessages(messages, options) {
    if (!messages) return [];
    
    let filtered = [...messages];
    
    if (options.before) {
      filtered = filtered.filter(msg => 
        new Date(msg.timestamp) < new Date(options.before)
      );
    }
    
    return filtered.slice(0, options.limit || 50);
  }

  async updateContactBatch(userId, contacts) {
    try {
      const { error } = await this.adminClient
        .from('whatsapp_contacts')
        .upsert(
          contacts.map(contact => ({
            ...contact,
            user_id: userId,
            updated_at: new Date().toISOString()
          })),
          { onConflict: 'id' }
        );

      if (error) throw error;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error updating contacts:', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  async updateMessageBatch(userId, contactId, messages) {
    try {
      const { error } = await this.adminClient
        .from('whatsapp_messages')
        .upsert(
          messages.map(message => ({
            ...message,
            user_id: userId,
            contact_id: contactId
          })),
          { onConflict: 'id' }
        );

      if (error) throw error;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error updating messages:', {
        userId,
        contactId,
        error: error.message
      });
      throw error;
    }
  }

  async getSyncState(userId) {
    return this.getFromCache(
      `sync:${userId}`,
      'syncStates',
      async () => {
        return this.fetchSyncStateFromDB(userId);
      }
    );
  }

  async invalidateCache(type, pattern) {
    const cache = this.cache[type];
    if (!cache) return;

    if (pattern) {
      // Remove matching entries
      for (const key of cache.keys()) {
        if (key.includes(pattern)) {
          cache.delete(key);
        }
      }
    } else {
      // Clear entire cache type
      cache.clear();
    }

    logger.info('[WhatsApp Entity] Cache invalidated:', {
      type,
      pattern: pattern || 'all'
    });
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

  async checkRateLimit(userId) {
    const now = Date.now();
    const userRequests = this.syncRateLimit.current.get(userId) || 0;
    const resetTime = this.syncRateLimit.resetTime.get(userId) || 0;

    // Reset counter if window has passed
    if (now > resetTime) {
      this.syncRateLimit.current.set(userId, 0);
      this.syncRateLimit.resetTime.set(userId, now + this.syncRateLimit.windowMs);
      return true;
    }

    // Check if limit exceeded
    if (userRequests >= this.syncRateLimit.maxRequests) {
      return false;
    }

    // Increment counter
    this.syncRateLimit.current.set(userId, userRequests + 1);
    return true;
  }

  async waitForSync(matrixClient) {
    if (!matrixClient) {
      throw new Error('Matrix client is required for sync');
    }

    return new Promise((resolve, reject) => {
      logger.debug('[WhatsApp Entity] Starting Matrix sync', {
        clientId: matrixClient.getUserId()
      });
      
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Matrix sync timeout after 30s'));
      }, this.SYNC_TIMEOUT);

      const cleanup = () => {
        logger.debug('[WhatsApp Entity] Cleaning up Matrix sync listeners');
        matrixClient.removeListener('sync', onSync);
        clearTimeout(timeout);
      };

      const onSync = (state, prevState, data) => {
        logger.debug('[WhatsApp Entity] Matrix sync state update:', {
          state,
          prevState,
          data
        });

        switch (state) {
          case 'PREPARED':
          case 'SYNCING':
            cleanup();
            resolve();
            break;

          case 'ERROR':
            if (data?.error?.message?.includes('M_UNKNOWN_TOKEN')) {
              cleanup();
              reject(new Error('Invalid Matrix access token'));
            } else if (data?.error?.message?.includes('timeout')) {
              // Don't fail on timeout, let the outer timeout handle it
              logger.warn('[WhatsApp Entity] Matrix sync timeout, continuing...');
            } else {
              cleanup();
              reject(new Error(`Matrix sync error: ${data?.error?.message || 'Unknown error'}`));
            }
            break;

          case 'RECONNECTING':
            logger.info('[WhatsApp Entity] Matrix client reconnecting, continuing...');
            break;

          default:
            logger.debug('[WhatsApp Entity] Unhandled sync state:', { state });
        }
      };

      matrixClient.on('sync', onSync);

      // Check if already synced
      if (matrixClient.isInitialSyncComplete()) {
        logger.debug('[WhatsApp Entity] Matrix client already synced');
        cleanup();
        resolve();
      }
    });
  }

  async getMatrixClient(userId) {
    try {
      // 1. Get Matrix account from database
      const { data: matrixAccount, error: accountError } = await this.adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (accountError) {
        logger.error('[WhatsApp Entity] Matrix account fetch failed:', {
          userId,
          error: accountError.message
        });
        throw new Error(`Matrix account not found: ${accountError.message}`);
      }

      if (!matrixAccount?.credentials) {
        logger.error('[WhatsApp Entity] Invalid Matrix credentials:', { userId });
        throw new Error('Matrix credentials not found');
      }

      // 2. Validate required credentials
      const { homeserver, accessToken, userId: matrixUserId } = matrixAccount.credentials;
      
      if (!homeserver || !accessToken || !matrixUserId) {
        const missingFields = [];
        if (!homeserver) missingFields.push('homeserver');
        if (!accessToken) missingFields.push('accessToken');
        if (!matrixUserId) missingFields.push('matrixUserId');
        
        logger.error('[WhatsApp Entity] Missing Matrix credentials:', {
          userId,
          missingFields
        });
        throw new Error(`Invalid Matrix credentials: missing ${missingFields.join(', ')}`);
      }

      // 3. Create Matrix client with retry mechanism
      const client = sdk.createClient({
        baseUrl: homeserver,
        accessToken: accessToken,
        userId: matrixUserId,
        timeoutMs: 10000,
        localTimeoutMs: 10000
      });

      // 4. Start client and wait for sync with enhanced error handling
      try {
        await client.startClient({
          initialSyncLimit: 10,
          lazyLoadMembers: true
        }).catch((error) => {
          console.error('[WhatsApp Entity] Matrix client start error:', {
            userId,
            error: error.message
          });
      throw error;
        });

        let retryCount = 0;
        const maxRetries = 3;
        const baseDelay = 1000;

        while (retryCount < maxRetries) {
          try {
            await this.waitForSync(client).catch((error) => {
              console.error('[WhatsApp Entity] Matrix client sync error while waitSync:', {
                userId,
                error: error.message
              });
      throw error;
            });
            logger.info('[WhatsApp Entity] Matrix client sync successful:', {
              userId,
              matrixUserId
            });
            return client;
          } catch (syncError) {
            retryCount++;
            
            // Log sync error details
            logger.warn('[WhatsApp Entity] Matrix sync error:', {
              userId,
              attempt: retryCount,
              error: syncError.message
            });

            // Handle specific error types
            if (syncError.message.includes('M_UNKNOWN_TOKEN')) {
              client.stopClient();
              throw new Error('Invalid Matrix access token');
            }

            // If it's not a recoverable error or we've hit max retries, throw
            if (retryCount === maxRetries || 
                !(syncError.message.includes('AbortError') || 
                  syncError.message.includes('timeout') ||
                  syncError.message.includes('RECONNECTING'))) {
              throw syncError;
            }

            // Exponential backoff before retry
            await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, retryCount)));
          }
        }

        throw new Error('Matrix sync failed after max retries');
      } catch (error) {
        client.stopClient();
        throw error;
      }
    } catch (error) {
      logger.error('[WhatsApp Entity] Matrix client error:', {
          userId,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Matrix client initialization failed: ${error.message}`);
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

  async updateSyncStatus(userId, contactId, updates) {
    try {
      const { state, progress, error, errorType, details, ...metadata } = updates;
      
      // Validate sync state
      if (!Object.values(this.SYNC_STATES).find(s => s.value === state)) {
        throw new Error(`Invalid sync state: ${state}`);
      }

      // Get current contact data
      const { data: contact, error: fetchError } = await this.adminClient
            .from('whatsapp_contacts')
        .select('metadata')
            .eq('user_id', userId)
            .eq('id', contactId)
            .single();

      if (fetchError) throw fetchError;

      // Merge existing metadata with updates
      const updatedMetadata = {
        ...(contact?.metadata || {}),
        ...metadata,
        progress: progress || 0,
        last_updated: new Date().toISOString()
      };

      // Add error information if present
      if (error) {
        updatedMetadata.error = error;
        updatedMetadata.error_type = errorType;
        updatedMetadata.error_time = new Date().toISOString();
      }

      // Add details if present
      if (details) {
        updatedMetadata.details = details;
      }

      // Update the contact
      const { error: updateError } = await this.adminClient
        .from('whatsapp_contacts')
        .update({
          sync_status: state,
          metadata: updatedMetadata,
        updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('id', contactId);

      if (updateError) throw updateError;

      // Emit socket event for status update
      const io = getIO();
      if (io) {
        io.to(`user:${userId}`).emit('whatsapp:sync_status', {
          contactId,
          state,
          progress: progress || 0,
          details,
          error,
          errorType,
          timestamp: new Date().toISOString()
        });
      }

      return updatedMetadata;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error updating sync status:', {
        userId,
        contactId,
        updates,
        error: error.message
      });
      throw error;
    }
  }

  async getCurrentSyncStatus(userId, contactId) {
    const { data } = await this.adminClient
      .from('whatsapp_contacts')
      .select('sync_status')
      .eq('user_id', userId)
      .eq('id', contactId)
      .single();
    
    return data?.sync_status;
  }

  isValidStatusTransition(fromStatus, toStatus) {
    const currentState = this.SYNC_STATES[fromStatus.toUpperCase()];
    return currentState?.allowedTransitions.includes(toStatus);
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
              if (this.syncInProgress.get(userId)) {
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

  // Add standardized retry mechanism
  async withRetry(operation, maxRetries = 3, delay = 1000) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          throw new Error(`Operation failed after ${maxRetries} attempts: ${error.message}`);
        }
        await new Promise(res => setTimeout(res, delay * Math.pow(2, attempt))); // Exponential backoff
      }
    }
  }

  // Add missing method for fetching messages with retry
  async _fetchMessagesFromRoomWithRetry(client, room, options = { limit: 50, maxRetries: 3 }) {
    return this.withRetry(
      async () => this._fetchMessagesFromRoom(client, room, options.limit),
      options.maxRetries
    );
  }

  async fetchSyncStateFromDB(userId) {
    try {
      const { data, error } = await this.adminClient
        .from('whatsapp_sync_requests')
        .select('*')
        .eq('user_id', userId)
        .order('requested_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        logger.error('[WhatsApp Entity] Error fetching sync state:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error in fetchSyncStateFromDB:', error);
      return null;
    }
  }

  async updateSyncProgress(userId, type, progress) {
    try {
      // Update progress in database
      const updateData = {
        sync_progress: progress,
        last_sync_attempt: new Date().toISOString()
      };

      if (type === 'contacts') {
        await this.adminClient
          .from('whatsapp_contacts')
          .update(updateData)
          .eq('user_id', userId);
      }

      // Emit progress via Socket.IO
      const io = getIO();
      if (io) {
        io.to(`user:${userId}`).emit('whatsapp:sync_progress', {
          type,
          progress,
          timestamp: new Date().toISOString()
        });
      }

      logger.info('[WhatsApp Entity] Sync progress updated:', {
        userId,
        type,
        progress
      });
    } catch (error) {
      logger.warn('[WhatsApp Entity] Error updating sync progress:', {
        userId,
        type,
        error: error.message
      });
    }
  }

  async _updateContacts(userId, contacts) {
    try {
      // Validate input
      if (!Array.isArray(contacts)) {
        throw new Error('Contacts must be an array');
      }

      // Prepare contacts for upsert
      const contactsToUpsert = contacts.map(contact => ({
        ...contact,
        user_id: userId,
        updated_at: new Date().toISOString(),
        sync_status: contact.sync_status || this.SYNC_STATES.PENDING
      }));

      // Perform upsert operation
      const { error } = await this.adminClient
        .from('whatsapp_contacts')
        .upsert(contactsToUpsert, {
          onConflict: 'id',
          returning: true
        });

      if (error) {
        throw error;
      }

      // Invalidate cache after successful update
      await this.invalidateCache('contacts', userId);

      logger.info('[WhatsApp Entity] Contacts updated successfully:', {
        userId,
        count: contacts.length
      });
    } catch (error) {
      logger.error('[WhatsApp Entity] Error in _updateContacts:', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  async handleSyncError(userId, contactId, error, context = {}) {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        // Log the error with context
        logger.error('[WhatsApp Entity] Sync error:', {
          userId,
          contactId,
          context,
          error: error.message,
          stack: error.stack,
          attempt: retryCount + 1
        });

        // First validate that the contact exists
        const { data: contact } = await this.adminClient
          .from('whatsapp_contacts')
          .select('*')
          .eq('user_id', userId)
          .eq('id', contactId)
          .single();

        if (!contact) {
          await this.updateSyncStatus(userId, contactId, 'rejected', {
            error: 'Contact not found',
            errorCode: 404,
            context,
            failedAt: new Date().toISOString(),
            retryCount,
            status: 'failed'
          });
          throw new APIError('Contact not found', 404);
        }

        // Update sync status to REJECTED with error details
        await this.updateSyncStatus(userId, contactId, 'rejected', {
          error: error.message,
          errorCode: error instanceof APIError ? error.status : 500,
          errorStack: error.stack,
          context,
          failedAt: new Date().toISOString(),
          retryCount,
          status: 'failed'
        });

        // Invalidate relevant caches
        await Promise.all([
          this.invalidateCache('messages', `${userId}:${contactId}`),
          this.invalidateCache('contacts', userId),
          this.invalidateCache('syncStates', `${userId}:${contactId}`)
        ]);

        // Release any held locks
        this._clearLock(context.lockKey);

        // Emit error event with retry information
        const io = getIO();
        if (io) {
          io.to(`user:${userId}`).emit('whatsapp:sync_error', {
            contactId,
            error: error.message,
            timestamp: new Date().toISOString(),
            attempt: retryCount + 1,
            status: 'rejected'
          });
        }

        break;
      } catch (handlerError) {
        retryCount++;
        
        logger.error('[WhatsApp Entity] Error in handleSyncError:', {
          userId,
          contactId,
          originalError: error.message,
          handlerError: handlerError.message,
          attempt: retryCount
        });

        if (retryCount === maxRetries) {
          const io = getIO();
          if (io) {
            io.to(`user:${userId}`).emit('whatsapp:critical_error', {
              contactId,
              error: 'Failed to handle sync error properly',
              timestamp: new Date().toISOString()
            });
          }
          throw handlerError;
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
      }
    }
  }

  // Add method to check sync completion status
  async checkSyncStatus(userId, contactId) {
    try {
      const { data: contact, error } = await this.adminClient
        .from('whatsapp_contacts')
        .select('sync_status, metadata')
        .eq('user_id', userId)
        .eq('id', contactId)
        .single();

      if (error) throw error;
      if (!contact) throw new Error('Contact not found');

      return {
        status: contact.sync_status,
        progress: contact.metadata?.progress || 0,
        stage: contact.metadata?.stage || 'unknown',
        isComplete: contact.sync_status === this.SYNC_STATES.APPROVED.value,
        error: contact.metadata?.error_details || null
      };
    } catch (error) {
      logger.error('[WhatsApp Entity] Error checking sync status:', {
        userId,
        contactId,
        error: error.message
      });
      throw error;
    }
  }

  async getWhatsAppRooms(client) {
    try {
      const rooms = client.getRooms();
      return rooms.filter(room => {
        // Check if room has bridge state event
        const bridgeEvent = room.currentState.getStateEvents('uk.half-shot.bridge', '');
        if (bridgeEvent && bridgeEvent.getContent().protocol === 'whatsapp') {
          return true;
        }
        
        // Check room name for WhatsApp suffix
        const name = room.name;
        return name && name.endsWith('(WA)');
      });
    } catch (error) {
      logger.error('[WhatsApp Entity] Error getting WhatsApp rooms:', {
        userId: client.getUserId(),
        error: error.message
      });
      return [];
    }
  }

  async getCachedContacts(userId) {
    try {
      // Try to get contacts from cache first
      const { data: contacts, error } = await this.adminClient
        .from('whatsapp_contacts')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      if (error) throw error;
      
      // Return cached contacts
      return contacts || [];
    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching cached contacts:', {
        userId,
        error: error.message
      });
      return []; // Return empty array on error to prevent crashes
    }
  }

  async createWhatsAppRoom(client, contact) {
    try {
      // Create room with retry
      const createResponse = await client.createRoom({
        visibility: 'private',
        invite: [this.bridgeBotUserId],
        preset: 'private_chat',
        initial_state: [
          {
            type: 'm.room.name',
            content: {
              name: `${contact.name || contact.whatsapp_id} (WA)`
            }
          },
          {
            type: 'uk.half-shot.bridge',
            state_key: '',
            content: {
              protocol: 'whatsapp',
              remote_id: contact.whatsapp_id,
              bridge: 'whatsapp'
            }
          }
        ],
        creation_content: {
          'm.federate': false
        }
      });

      // Wait for room to be available
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const newRoom = client.getRoom(createResponse.room_id);
      if (!newRoom) {
        throw new Error('Room not available after creation');
      }

      // Invite bridge bot if not already in room
      const bridgeBotMember = newRoom.getMember(this.bridgeBotUserId);
      if (!bridgeBotMember || bridgeBotMember.membership !== 'join') {
        try {
          await client.invite(createResponse.room_id, this.bridgeBotUserId);
          logger.info('[WhatsApp Entity] Invited bridge bot to room:', {
            roomId: createResponse.room_id,
            bridgeBotUserId: this.bridgeBotUserId
          });

          // Wait for bridge bot to join
          let attempts = 0;
          const maxAttempts = 5; // Reduced from 10 to 5 attempts
          const checkInterval = 1000;

          while (attempts < maxAttempts) {
            const room = client.getRoom(createResponse.room_id);
            const member = room?.getMember(this.bridgeBotUserId);
            
            if (member?.membership === 'join') {
              logger.info('[WhatsApp Entity] Bridge bot joined room:', {
                roomId: createResponse.room_id,
                attempts: attempts + 1
              });
              break;
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
            attempts++;

            if (attempts === maxAttempts) {
              logger.warn('[WhatsApp Entity] Bridge bot did not join room after max attempts:', {
                roomId: createResponse.room_id,
                maxAttempts
              });
              // Continue even if bridge bot hasn't joined - it might join later
            }
          }
        } catch (inviteError) {
          logger.warn('[WhatsApp Entity] Failed to invite bridge bot:', {
            roomId: createResponse.room_id,
            error: inviteError.message
          });
          // Continue even if invite fails - the bridge bot might join automatically
        }
      }

      // Return room ID even if bridge bot hasn't joined yet
      return createResponse.room_id;
    } catch (error) {
      logger.error('[WhatsApp Entity] Room creation failed:', {
        contactId: contact.id,
        error: error.message
      });
      throw error;
    }
  }

  async getOrCreateRoomId(userId, contactId, client) {
    const contact = await this.getContact(userId, contactId);
    const roomId = contact.metadata?.room_id;

    if (roomId) {
      logger.debug('[WhatsApp Entity] Validating room:', {
        userId,
        contactId,
        roomId,
        clientSyncState: client.getSyncState(),
        roomInClientState: !!client.getRoom(roomId)
      });

      // 1. First try direct client access
      let room = client.getRoom(roomId);
      
      // 2. If not found, force a room state fetch
      if (!room) {
        try {
          logger.info('[WhatsApp Entity] Room not in client state, fetching manually:', { 
          userId, 
          contactId, 
          roomId 
        });
        
          // Force fetch room state
          await client.http.authedRequest(
            undefined,
            "GET",
            "/rooms/" + encodeURIComponent(roomId) + "/state"
          );
          
          // Wait for client to process state
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Try getting room again
          room = client.getRoom(roomId);
          
          if (room) {
            logger.info('[WhatsApp Entity] Successfully recovered room after manual fetch:', { 
              userId, 
              contactId, 
              roomId 
            });
            return roomId;
          }
        } catch (error) {
          logger.warn('[WhatsApp Entity] Failed to fetch room state:', { 
            userId,
            contactId,
            roomId, 
            error: error.message 
          });
        }
      }

      // 3. If still not found, try rejoining
      if (!room) {
        try {
          logger.info('[WhatsApp Entity] Attempting to rejoin room:', {
            userId,
            contactId,
            roomId
          });

          await client.joinRoom(roomId);
          
          // Wait for join to process
          await new Promise(resolve => setTimeout(resolve, 500));
          room = client.getRoom(roomId);
          
          if (room) {
            logger.info('[WhatsApp Entity] Successfully rejoined room:', {
              userId,
              contactId,
              roomId
            });
            return roomId;
          }
        } catch (error) {
          logger.error('[WhatsApp Entity] Failed to rejoin room:', {
            userId,
            contactId,
            roomId,
            error: error.message
          });
        }
      }

      // 4. Final validation if room was found
      if (room) {
        const userMember = room.getMember(client.getUserId());
        const bridgeBotMember = room.getMember(this.bridgeBotUserId);
        
        if (userMember?.membership === 'join' && bridgeBotMember?.membership === 'join') {
          return roomId;
        }
        
        logger.warn('[WhatsApp Entity] Room found but members not joined:', {
          userId,
          contactId,
          roomId,
          userMembership: userMember?.membership,
          bridgeBotMembership: bridgeBotMember?.membership
        });
      }
    }

    // Only create new room if all recovery attempts fail
    logger.info('[WhatsApp Entity] Creating new room after recovery attempts failed:', {
      userId,
      contactId,
      originalRoomId: roomId
    });
    
    return this.createNewRoom(userId, contactId, client);
  }

  async getMatrixClientWithRetry(userId, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = await this.getMatrixClient(userId);
        if (client) {
          return client;
        }
      } catch (error) {
        lastError = error;
        logger.warn('[WhatsApp Entity] Matrix client retry failed:', {
          userId,
          attempt,
          error: error.message
        });

        // Don't retry on auth errors
        if (error.message.includes('M_UNKNOWN_TOKEN') || 
            error.message.includes('Invalid Matrix credentials')) {
          throw error;
        }

        // Wait before next retry using exponential backoff
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error('Failed to get Matrix client after max retries');
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
    const cachedContacts = await redisService.get(CACHE_KEY);
    if (cachedContacts) {
      const parsed = JSON.parse(cachedContacts);
      // Return cached data if it's less than 5 minutes old
      if (Date.now() - parsed.timestamp < CACHE_DURATION * 1000) {
        return parsed.contacts;
      }
    }

    // Fetch fresh contacts
    const contacts = await whatsappEntityService.syncContacts(userId);
    
    // Cache with metadata
    const contactData = {
      contacts,
      timestamp: Date.now(),
      count: contacts.length
    };

    // Set cache with expiration
    await redisService.set(
      CACHE_KEY,
      JSON.stringify(contactData),
      'EX',
      CACHE_DURATION
    );

    // Set a secondary index for quick contact count
    await redisService.set(
      `whatsapp:${userId}:contact_count`,
      contacts.length,
      'EX',
      CACHE_DURATION
    );

    return contacts;
  } catch (error) {
    console.error('Failed to fetch contacts:', error);
    // Return cached data if available, even if expired
    const staleCache = await redisService.get(CACHE_KEY);
    if (staleCache) {
      return JSON.parse(staleCache).contacts;
    }
    throw error;
  }
}

export async function updateContact(userId, contactId, updates) {
  try {
    const result = await whatsappEntityService.updateContactStatus(userId, contactId, updates.sync_status, updates.error);
    
    // Invalidate contact cache
    await redisService.del(`whatsapp:${userId}:contacts`);
    await redisService.del(`whatsapp:${userId}:contact_count`);
    
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