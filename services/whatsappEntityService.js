import { adminClient } from '../utils/supabase.js';
import { matrixWhatsAppService } from './matrixWhatsAppService.js';
import { BRIDGE_CONFIGS } from '../config/bridgeConfig.js';
import * as sdk from 'matrix-js-sdk';
import { getIO } from '../utils/socket.js';
import { redisClient } from '../utils/redis.js';
import { logger } from '../utils/logger.js';
import Redlock from 'redlock';

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

    // Initialize Redlock with Redis client
    try {
      this.redlock = new Redlock(
        [redisClient.pubClient], // Use pubClient from the redisClient service
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
        allowedTransitions: ['syncing', 'approved', 'rejected'],
        metadata: {
          status: 'waiting',
          progress: 0,
          stage: 'initializing'
        }
      },
      SYNCING: {
        value: 'syncing',
        allowedTransitions: ['approved', 'rejected'],
        metadata: {
          status: 'in_progress',
          progress: 0,
          stage: 'processing'
        }
      },
      APPROVED: {
        value: 'approved',
        allowedTransitions: ['pending'],
        metadata: {
          status: 'completed',
          progress: 100,
          stage: 'done'
        }
      },
      REJECTED: {
        value: 'rejected',
        allowedTransitions: ['pending'],
        metadata: {
          status: 'failed',
          progress: 0,
          stage: 'error'
        }
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
    try {
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
            this.syncContacts(userId).catch(error => {
              logger.error('[WhatsApp Entity] Background sync failed:', {
                userId,
                error: error.message
              });
            });
          }

          return cached;
        }
      }

      // No cache or force sync, perform full sync
      const contacts = await this.syncContacts(userId);
      return contacts;

    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching contacts:', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  async syncContacts(userId) {
    const lockKey = `sync:contacts:${userId}`;
    let lock = null;

    try {
      // Acquire sync lock
      if (this.redlock) {
        try {
      lock = await this.redlock.acquire([lockKey], 30000);
        } catch (error) {
          logger.warn('[WhatsApp Entity] Failed to acquire contact sync lock:', {
            userId,
            error: error.message
          });
          // Continue without lock if redlock is not working
        }
      }

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
    } finally {
      if (lock) {
        try {
          await lock.release();
        } catch (error) {
          logger.warn('[WhatsApp Entity] Failed to release contact sync lock:', {
            userId,
            error: error.message
          });
        }
      }
    }
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

  async getMessages(userId, contactId, options = { limit: 50, before: null }) {
    try {
      // Try cache first
      const cacheKey = `messages:${userId}:${contactId}`;
      const cached = await this.getFromCache(
        cacheKey,
        'messages',
        async () => {
          const { data: messages, error } = await this.adminClient
            .from('whatsapp_messages')
            .select('*')
            .eq('user_id', userId)
            .eq('contact_id', contactId)
            .order('timestamp', { ascending: false })
            .limit(options.limit);

          if (error) throw error;
          return messages;
        }
      );

      if (cached?.length > 0) {
        // Start background sync
        this.syncMessages(userId, contactId).catch(error => {
          logger.error('[WhatsApp Entity] Background message sync failed:', {
            userId,
            contactId,
            error: error.message
          });
        });

        return this.filterMessages(cached, options);
      }

      // No cache, perform sync
      const messages = await this.syncMessages(userId, contactId);
      return this.filterMessages(messages, options);

    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching messages:', {
        userId,
        contactId,
        error: error.message
      });
      throw error;
    }
  }

  async syncMessages(userId, contactId) {
    const lockKey = `sync:messages:${userId}:${contactId}`;

    try {
      // Check rate limit first
      await this.checkRateLimit(userId);

      return await this.withLock(lockKey, async () => {
        // Update status to syncing
        await this.updateSyncStatus(userId, contactId, this.SYNC_STATES.SYNCING.value, {
          progress: 0,
          stage: 'initializing',
          started_at: new Date().toISOString()
        });

        // Get Matrix client
        const client = await this.getMatrixClient(userId);
        if (!client) {
          throw new Error('Matrix client not available');
        }

        // Update progress - 10%
        await this.updateSyncProgress(userId, contactId, 10, 'client_ready');

        // Get contact details
        const { data: contact, error: contactError } = await this.adminClient
          .from('whatsapp_contacts')
          .select('*')
          .eq('user_id', userId)
          .eq('id', parseInt(contactId))
          .single();

        if (contactError) throw contactError;
        if (!contact) {
          throw new Error('Contact not found');
        }

        // Update progress - 20%
        await this.updateSyncProgress(userId, contactId, 20, 'contact_validated');

        // Validate and prepare for sync
        const { room, roomId } = await this.validateAndPrepareSync(userId, contactId, client, contact);

        // Update progress - 40%
        await this.updateSyncProgress(userId, contactId, 40, 'room_validated');

        // Fetch messages from room with retries
        const messages = await this._fetchMessagesFromRoomWithRetry(client, room, {
          limit: 50,
          maxRetries: 3
        });

        // Update progress - 60%
        await this.updateSyncProgress(userId, contactId, 60, 'messages_fetched');

        // Update database in batches with progress tracking
        const batchSize = 50;
        for (let i = 0; i < messages.length; i += batchSize) {
          const batch = messages.slice(i, i + batchSize);
          await this.updateMessageBatch(userId, contactId, batch);

          const progress = Math.min(90, 60 + Math.round(((i + batchSize) / messages.length) * 30));
          await this.updateSyncProgress(userId, contactId, progress, 'processing_messages');

          // Add small delay between batches
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Update cache
        await this.invalidateCache('messages', `${userId}:${contactId}`);

        // Update final sync status
        await this.updateSyncStatus(userId, contactId, this.SYNC_STATES.APPROVED.value, {
          progress: 100,
          stage: 'completed',
          completed_at: new Date().toISOString(),
          message_count: messages.length
        });

        return messages;
      });

    } catch (error) {
      await this.handleSyncError(userId, contactId, error, {
        operation: 'syncMessages',
        lockKey
      });
      throw error;
    }
  }

  filterMessages(messages, options) {
    let filtered = [...messages];

    if (options.before) {
      filtered = filtered.filter(msg => msg.timestamp < options.before);
    }

    return filtered.slice(0, options.limit);
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
            contact_id: contactId,
            updated_at: new Date().toISOString()
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

  async getMatrixClient(userId) {
    try {
      // Get Matrix account from database using adminClient
      const { data: matrixAccount, error } = await this.adminClient
        .from('accounts')
        .select('credentials')
        .eq('user_id', userId)
        .eq('platform', 'matrix')
        .single();

      if (error) throw error;
      if (!matrixAccount?.credentials) throw new Error('Matrix credentials not found');

      const { homeserver, accessToken, userId: matrixUserId } = matrixAccount.credentials;
      if (!homeserver || !accessToken || !matrixUserId) {
        throw new Error('Invalid Matrix credentials');
      }

      const client = sdk.createClient({
        baseUrl: homeserver,
        accessToken: accessToken,
        userId: matrixUserId
      });

      return client;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error getting Matrix client:', {
        userId,
        error: error.message
      });
      throw error;
    }
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

  async updateSyncStatus(userId, contactId, newStatus, metadata = {}) {
    try {
      // Validate status transition
      const currentStatus = await this.getCurrentSyncStatus(userId, contactId);
      if (currentStatus && !this.isValidStatusTransition(currentStatus, newStatus)) {
        throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}`);
      }

      // Prepare metadata with enhanced tracking
      const enhancedMetadata = {
        ...metadata,
        last_update: new Date().toISOString(),
        status_history: [
          ...(metadata.status_history || []),
          {
            from: currentStatus,
            to: newStatus,
              timestamp: new Date().toISOString(),
            reason: metadata.reason || 'status_update'
          }
        ].slice(-10), // Keep last 10 status changes
        error_details: metadata.error ? {
          message: metadata.error.message,
          code: metadata.error.code,
          context: metadata.error.context,
          timestamp: new Date().toISOString()
        } : null
      };

      // Update database with new status
      const { data, error } = await this.adminClient
        .from('whatsapp_contacts')
        .update({
          sync_status: newStatus,
          metadata: enhancedMetadata,
          updated_at: new Date().toISOString()
        })
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
          status: newStatus,
          metadata: enhancedMetadata,
          timestamp: new Date().toISOString()
        });
      }

      logger.info('[WhatsApp Entity] Sync status updated:', {
        userId,
        contactId,
        from: currentStatus,
        to: newStatus,
        metadata: enhancedMetadata
      });

      return data;

    } catch (error) {
      logger.error('[WhatsApp Entity] Error updating sync status:', {
        userId,
        contactId,
        newStatus,
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

  // Enhanced lock management with retry logic
  async acquireLock(lockKey, timeout = 30000) {
    const start = Date.now();
    let lastError = null;
    let attempts = 0;
    const maxRetries = 5;
    
    // Configure retry strategy
    const retryStrategy = {
      baseDelay: 1000,  // Start with 1 second
      maxDelay: 5000,   // Cap at 5 seconds
      jitter: 0.2       // Add 20% random jitter
    };
    
    while (Date.now() - start < timeout && attempts < maxRetries) {
      try {
        // Calculate delay with exponential backoff and jitter
        const delay = Math.min(
          retryStrategy.baseDelay * Math.pow(2, attempts),
          retryStrategy.maxDelay
        );
        const jitter = delay * retryStrategy.jitter * (Math.random() - 0.5);
        const finalDelay = delay + jitter;

        // Try to acquire lock
        const lock = await this.redlock.acquire(
          [lockKey],
          Math.min(5000, timeout - (Date.now() - start)), // Ensure we don't exceed timeout
          {
            retryCount: 2,
          retryDelay: 200,
          retryJitter: 100
          }
        );
        
        // Log success
        logger.info(`[WhatsApp Entity] Lock acquired: ${lockKey}`, {
          attempt: attempts + 1,
          duration: Date.now() - start,
          finalDelay
        });
        
        // Register cleanup handler
        this._registerLockCleanup(lock, lockKey);
        
        return lock;

      } catch (error) {
        lastError = error;
        attempts++;
        
        // Log retry attempt
        logger.warn(`[WhatsApp Entity] Lock acquisition attempt ${attempts} failed:`, {
          lockKey,
          error: error.message,
          nextRetryIn: finalDelay,
          remainingTime: timeout - (Date.now() - start)
        });
        
        if (attempts < maxRetries && Date.now() - start < timeout) {
          await new Promise(resolve => setTimeout(resolve, finalDelay));
        }
      }
    }
    
    // Enhanced error reporting
    const enhancedError = new Error(
      `Failed to acquire lock after ${attempts} attempts: ${lastError?.message}`
    );
    enhancedError.context = {
      lockKey,
      attempts,
      duration: Date.now() - start,
      lastError
    };
    throw enhancedError;
  }

  async releaseLock(lock, lockKey) {
    if (!lock) return;

    try {
      await lock.release();
      this._clearLockCleanup(lockKey);
      logger.info(`[WhatsApp Entity] Lock released: ${lockKey}`);
    } catch (error) {
      logger.warn(`[WhatsApp Entity] Failed to release lock: ${lockKey}`, {
        error: error.message
      });
      
      // Enhanced force release with monitoring
      this._forceReleaseLock(lock, lockKey);
    }
  }

  // Helper method to register cleanup handler
  _registerLockCleanup(lock, lockKey) {
    const timeoutId = setTimeout(() => {
      logger.warn(`[WhatsApp Entity] Lock timeout triggered for ${lockKey}`);
      this._forceReleaseLock(lock, lockKey);
    }, this.LOCK_TIMEOUT);

    this.lockTimeouts.set(lockKey, {
      timeoutId,
      lock,
      acquiredAt: Date.now()
    });
  }

  // Helper method to clear cleanup handler
  _clearLockCleanup(lockKey) {
    const cleanup = this.lockTimeouts.get(lockKey);
    if (cleanup) {
      clearTimeout(cleanup.timeoutId);
      this.lockTimeouts.delete(lockKey);
    }
  }

  // Enhanced force release with retry
  async _forceReleaseLock(lock, lockKey, attempt = 1) {
    const maxAttempts = 3;
    const baseDelay = 1000;

        try {
          await this.redlock.release(lock);
          logger.info(`[WhatsApp Entity] Force released lock: ${lockKey}`, {
            attempt
          });
      this._clearLockCleanup(lockKey);
    } catch (error) {
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 5000);
            logger.warn(`[WhatsApp Entity] Retry force release in ${delay}ms:`, {
              lockKey,
              attempt,
          error: error.message
            });
        
        setTimeout(() => this._forceReleaseLock(lock, lockKey, attempt + 1), delay);
          } else {
            logger.error(`[WhatsApp Entity] Failed to force release lock after ${attempt} attempts:`, {
              lockKey,
          error: error.message
        });
        
        // Emit critical alert for manual intervention
        this._emitLockAlert(lockKey, error);
      }
    }
  }

  // Helper method to emit lock alerts
  _emitLockAlert(lockKey, error) {
    const io = getIO();
    if (io) {
      io.emit('whatsapp:lock_alert', {
        type: 'LOCK_ERROR',
        lockKey,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }

    // Log critical error for monitoring
    logger.error('[WhatsApp Entity] Critical lock error:', {
      lockKey,
      error: error.message,
      stack: error.stack
    });
  }

  // Enhanced withLock helper with better error handling
  async withLock(lockKey, operation, timeout = 30000) {
    let lock = null;
    const start = Date.now();

    try {
      lock = await this.acquireLock(lockKey, timeout);
      
      // Monitor operation execution time
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Operation timeout')), timeout)
        )
      ]);

      // Log successful operation
      logger.info(`[WhatsApp Entity] Operation completed with lock:`, {
        lockKey,
        duration: Date.now() - start
      });

      return result;

    } catch (error) {
      // Enhanced error context
      const enhancedError = new Error(`Lock operation failed: ${error.message}`);
      enhancedError.context = {
        lockKey,
        operation: operation.name,
        duration: Date.now() - start,
        originalError: error
      };
      throw enhancedError;

    } finally {
      if (lock) {
        await this.releaseLock(lock, lockKey);
      }
    }
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
      logger.error('[WhatsApp Entity] Error getting last message:', error);
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
      logger.error('[WhatsApp Entity] Error updating contacts:', {
        userId,
        error: error.message
      });
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

  async getWhatsAppRooms(client) {
    try {
      const rooms = client.getRooms();
      return rooms.filter(room => {
        // Check if room has bridge bot
        const members = room.getJoinedMembers();
        const hasBridgeBot = members.some(member => member.userId === this.bridgeBotUserId);
        if (!hasBridgeBot) return false;

        // Check room name or state for WhatsApp indicators
        const isWhatsApp = room.name?.includes('WhatsApp') ||
          room.getStateEvents('m.room.whatsapp')?.length > 0;

        return isWhatsApp;
      });
    } catch (error) {
      logger.error('[WhatsApp Entity] Error getting WhatsApp rooms:', error);
      return [];
    }
  }

  extractWhatsAppId(room) {
    try {
      // Try to get from room state first
      const whatsappState = room.getStateEvents('m.room.whatsapp')[0];
      if (whatsappState?.getContent()?.whatsapp_id) {
        return whatsappState.getContent().whatsapp_id;
      }

      // Try to extract from room name
      const match = room.name?.match(/WhatsApp \((.*?)\)/);
      return match?.[1] || null;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error extracting WhatsApp ID:', {
        roomId: room.roomId,
        error: error.message
      });
      return null;
    }
  }

  getUnreadCount(room) {
    try {
      const timeline = room.getLiveTimeline();
      const events = timeline.getEvents();
      
      if (events.length === 0) return 0;

      const readUpTo = room.getEventReadUpTo(room.myUserId);
      if (!readUpTo) return events.length;

      return events.filter(event => 
        event.getId() > readUpTo &&
        event.getSender() !== room.myUserId &&
        event.getType() === 'm.room.message'
      ).length;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error getting unread count:', {
        roomId: room.roomId,
        error: error.message
      });
      return 0;
    }
  }

  async checkServerConnection(client) {
    try {
      const response = await client.getVersions();
      return !!response;
    } catch (error) {
      logger.error('[WhatsApp Entity] Server connection check failed:', error);
      return false;
    }
  }

  async validateMatrixSession(client, retryCount = 0) {
    try {
      // Check if client exists
      if (!client) {
        throw new Error('Matrix client is null');
      }

      // Check server connection first
      const serverAlive = await this.checkServerConnection(client);
      if (!serverAlive) {
        throw new Error('Matrix server not responding');
      }

      // Check if client is logged in
      const isLoggedIn = await client.isLoggedIn();
      if (!isLoggedIn) {
        throw new Error('Matrix client session is invalid');
      }

      // Check if client is running
      if (!client.clientRunning) {
        logger.info('[WhatsApp Entity] Starting Matrix client...');
        
        // Reduce initial sync limit for faster completion
        await client.startClient({ initialSyncLimit: 5 });
        
        // Progressive timeout with status checks
        const timeout = 60000; // 60 seconds total
        const checkInterval = 1000; // Check every second
        let elapsed = 0;

        while (elapsed < timeout) {
          if (client.isInitialSyncComplete()) {
            logger.info('[WhatsApp Entity] Initial sync completed successfully');
            break;
          }
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          elapsed += checkInterval;

          // Log progress every 5 seconds
          if (elapsed % 5000 === 0) {
            logger.info(`[WhatsApp Entity] Waiting for initial sync... ${elapsed/1000}s elapsed`);
          }
        }

        if (elapsed >= timeout) {
          throw new Error('Initial sync timeout after 60s');
        }
      }

      // Verify access token is valid
      try {
        await client.whoami();
      } catch (error) {
        throw new Error('Invalid access token');
      }

      logger.info('[WhatsApp Entity] Matrix session validated successfully');
      return true;

    } catch (error) {
      logger.error('[WhatsApp Entity] Session validation failed:', error);

      // Add retry logic with progressive backoff
      if (retryCount < 3) {
        const backoff = Math.min(1000 * Math.pow(2, retryCount), 30000);
        logger.info(`[WhatsApp Entity] Retrying session validation in ${backoff/1000}s...`);
        
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.validateMatrixSession(client, retryCount + 1);
      }

      throw new Error(`Session validation failed after ${retryCount} retries: ${error.message}`);
    }
  }

  async validateRoomAccess(client, roomId) {
    const validationStart = Date.now();
    const validationSteps = [];
    
    try {
      // Step 1: Check room existence
      const room = client.getRoom(roomId);
      if (!room) {
        throw new Error(`Room ${roomId} not found`);
      }
      validationSteps.push({ step: 'room_exists', success: true });

      // Step 2: Check bot membership and permissions
      const botMember = room.getMember(client.getUserId());
      if (!botMember) {
        throw new Error(`Bot is not a member of room ${roomId}`);
      }
      validationSteps.push({ step: 'bot_member_exists', success: true });

      // Step 3: Check membership status and join if needed
      if (botMember.membership !== 'join') {
        try {
          logger.info(`[WhatsApp Entity] Attempting to join room ${roomId}`);
          await client.joinRoom(roomId);
          logger.info(`[WhatsApp Entity] Successfully joined room ${roomId}`);
          validationSteps.push({ step: 'join_room', success: true });
        } catch (joinError) {
          validationSteps.push({ 
            step: 'join_room', 
            success: false,
            error: joinError.message 
          });
          throw new Error(`Failed to join room ${roomId}: ${joinError.message}`);
        }
      }

      // Step 4: Check timeline access
      const timeline = room.getLiveTimeline();
      if (!timeline) {
        validationSteps.push({ step: 'timeline_access', success: false });
        throw new Error(`Cannot access timeline for room ${roomId}`);
      }
      validationSteps.push({ step: 'timeline_access', success: true });

      // Step 5: Check power levels and permissions
      const powerLevels = room.currentState.getStateEvents('m.room.power_levels', '');
      const eventsDefault = powerLevels?.getContent()?.events_default || 0;
      const botPowerLevel = room.getMember(client.getUserId())?.powerLevel || 0;
      
      if (botPowerLevel < eventsDefault) {
        validationSteps.push({ 
          step: 'power_levels', 
          success: false,
          details: { botPowerLevel, eventsDefault } 
        });
        throw new Error(`Insufficient permissions in room ${roomId}. Bot power level: ${botPowerLevel}, Required: ${eventsDefault}`);
      }
      validationSteps.push({ 
        step: 'power_levels', 
        success: true,
        details: { botPowerLevel, eventsDefault } 
      });

      // Step 6: Verify message access
      const events = timeline.getEvents();
      validationSteps.push({ 
        step: 'message_access', 
        success: true,
        details: { eventCount: events.length } 
      });

      // Log successful validation
      logger.info('[WhatsApp Entity] Room validation successful:', {
        roomId,
        duration: Date.now() - validationStart,
        steps: validationSteps
      });

      return {
        room,
        validationDetails: {
          duration: Date.now() - validationStart,
          steps: validationSteps,
          botPowerLevel,
          eventsDefault,
          membership: botMember.membership,
          eventCount: events.length
        }
      };

    } catch (error) {
      // Enhanced error logging with validation context
      logger.error('[WhatsApp Entity] Room validation failed:', {
        roomId,
        error: error.message,
        duration: Date.now() - validationStart,
        steps: validationSteps,
        stack: error.stack
      });

      // Rethrow with enhanced context
      const enhancedError = new Error(`Room validation failed: ${error.message}`);
      enhancedError.validationSteps = validationSteps;
      enhancedError.duration = Date.now() - validationStart;
      throw enhancedError;
    }
  }

  async validateAndPrepareSync(userId, contactId, client, contact) {
    try {
      // 1. Validate Matrix session
      await this.validateMatrixSession(client);

      // 2. Get room ID
      const roomId = contact.bridge_room_id || contact.metadata?.room_id;
      if (!roomId) {
        throw new Error('No room ID found for contact');
      }

      // 3. Validate room access
      const roomValidationResult = await this.validateRoomAccess(client, roomId);

      // 4. Check sync state
      const syncState = await this.getSyncState(userId, contactId);
      if (syncState?.status === this.SYNC_STATES.SYNCING) {
        throw new Error('Sync already in progress');
      }

      return { room: roomValidationResult.room, roomId };
    } catch (error) {
      logger.error('[WhatsApp Entity] Sync preparation failed:', error);
      throw new Error(`Sync preparation failed: ${error.message}`);
    }
  }

  async getSyncState(userId, contactId) {
    try {
      const { data, error } = await this.adminClient
        .from('whatsapp_sync_requests')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('requested_at', { ascending: false })
        .limit(1)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('[WhatsApp Entity] Error fetching sync state:', error);
      return null;
    }
  }

  async _fetchMessagesFromRoomWithRetry(client, room, options = { limit: 50, maxRetries: 3 }) {
    let attempts = 0;
    let lastError;
    const maxRetries = options.maxRetries || 3;
    const initialDelay = 1000; // Start with 1 second delay

    while (attempts < maxRetries) {
      try {
        // Check room state before fetching
        if (!room || !client.getRoom(room.roomId)) {
          throw new Error('Room no longer accessible');
        }

        // Verify timeline access
        const timeline = room.getLiveTimeline();
        if (!timeline) {
          throw new Error('Timeline not accessible');
        }

        // Attempt to fetch messages
        const messages = await this._fetchMessagesFromRoom(client, room.roomId, options.limit);
        
        if (!messages || messages.length === 0) {
          logger.warn('[WhatsApp Entity] No messages found in room:', {
            roomId: room.roomId,
            attempt: attempts + 1
          });
        } else {
          logger.info('[WhatsApp Entity] Successfully fetched messages:', {
            roomId: room.roomId,
            count: messages.length
          });
        }

        return messages;

      } catch (error) {
        lastError = error;
        attempts++;
        
        // Log the error with context
        logger.error('[WhatsApp Entity] Failed to fetch messages:', {
          roomId: room.roomId,
          attempt: attempts,
          maxRetries,
          error: error.message
        });

        if (attempts === maxRetries) {
          break;
        }

        // Exponential backoff with jitter
        const backoff = Math.min(
          initialDelay * Math.pow(2, attempts) + Math.random() * 1000,
          30000 // Max 30 second delay
        );
        
        logger.info('[WhatsApp Entity] Retrying message fetch:', {
          roomId: room.roomId,
          attempt: attempts,
          backoffMs: backoff
        });

        await new Promise(resolve => setTimeout(resolve, backoff));
        
        // Verify client is still valid before retry
        try {
          await client.whoami();
        } catch (sessionError) {
          throw new Error('Matrix session invalid during retry');
        }
      }
    }

    throw new Error(
      `Failed to fetch messages after ${maxRetries} attempts. Last error: ${lastError?.message}`
    );
  }

  async checkRateLimit(userId) {
    const now = Date.now();
    const windowStart = this.syncRateLimit.resetTime.get(userId) || 0;
    
    // Reset counter if window has expired
    if (now - windowStart >= this.syncRateLimit.windowMs) {
      this.syncRateLimit.current.set(userId, 0);
      this.syncRateLimit.resetTime.set(userId, now);
    }

    const currentRequests = this.syncRateLimit.current.get(userId) || 0;
    if (currentRequests >= this.syncRateLimit.maxRequests) {
      throw new Error(`Rate limit exceeded. Try again in ${Math.ceil((windowStart + this.syncRateLimit.windowMs - now) / 1000)}s`);
    }

    this.syncRateLimit.current.set(userId, currentRequests + 1);
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
    try {
      // Log the error
      logger.error('[WhatsApp Entity] Sync error:', {
        userId,
        contactId,
        context,
        error: error.message
      });

      // Update sync status to REJECTED with error details
      if (contactId) {
        await this.updateSyncStatus(userId, contactId, this.SYNC_STATES.REJECTED.value, {
          error: error.message,
          context,
          status: 'failed'
        });
      }

      // Invalidate relevant caches
      if (contactId) {
        await this.invalidateCache('messages', `${userId}:${contactId}`);
      }
      await this.invalidateCache('contacts', userId);

      // Release any held locks
      const lockKey = contactId ? 
        `sync:messages:${userId}:${contactId}` : 
        `sync:contacts:${userId}`;
      
      this._clearLock(lockKey);

      // Emit error event
      const io = getIO();
      if (io) {
        io.to(`user:${userId}`).emit('whatsapp:sync_error', {
          contactId,
          error: error.message,
          timestamp: new Date().toISOString(),
          status: 'rejected'
        });
      }
    } catch (handlerError) {
      logger.error('[WhatsApp Entity] Error in handleSyncError:', handlerError);
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
    const cachedContacts = await redisClient.get(CACHE_KEY);
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
    await redisClient.set(
      CACHE_KEY,
      JSON.stringify(contactData),
      'EX',
      CACHE_DURATION
    );

    // Set a secondary index for quick contact count
    await redisClient.set(
      `whatsapp:${userId}:contact_count`,
      contacts.length,
      'EX',
      CACHE_DURATION
    );

    return contacts;
  } catch (error) {
    console.error('Failed to fetch contacts:', error);
    // Return cached data if available, even if expired
    const staleCache = await redisClient.get(CACHE_KEY);
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
    await redisClient.del(`whatsapp:${userId}:contacts`);
    await redisClient.del(`whatsapp:${userId}:contact_count`);
    
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