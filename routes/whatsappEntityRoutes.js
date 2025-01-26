import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { whatsappEntityService } from '../services/whatsappEntityService.js';
import { matrixWhatsAppService } from '../services/matrixWhatsAppService.js';
import { validateRequest } from '../middleware/validation.js';
import { adminClient } from '../utils/supabase.js';
import { APIError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// In-memory sync status tracking with TTL management
const activeSyncs = new Map();
const SYNC_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Enhanced SyncManager with TTL and recovery
const SyncManager = {
  _cleanupInterval: null,

  startCleanupInterval() {
    if (!this._cleanupInterval) {
      this._cleanupInterval = setInterval(() => this.cleanupStaleSync(), 60 * 1000);
      this._cleanupInterval.unref(); // Don't prevent process exit
    }
  },

  stopCleanupInterval() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  },

  // Helper method to emit socket events with retry
  _emitSyncUpdate: async (userId, contactId, update) => {
    try {
      const io = global.io;
      if (!io) {
        logger.warn('[SyncManager] Socket.io instance not available');
        return;
      }

      const event = {
        contactId: parseInt(contactId),
        timestamp: new Date().toISOString(),
        ...update
      };

      // Emit with retry logic
      const maxRetries = 3;
      let attempts = 0;
      
      while (attempts < maxRetries) {
        try {
          await new Promise((resolve, reject) => {
            io.to(`user:${userId}`).emit('whatsapp:sync_status', event, (ack) => {
              if (ack?.error) reject(new Error(ack.error));
              else resolve();
            });

            // Timeout after 5 seconds
            setTimeout(() => reject(new Error('Emit timeout')), 5000);
          });
          break; // Success, exit retry loop
        } catch (error) {
          attempts++;
          if (attempts === maxRetries) {
            logger.error('[SyncManager] Max retry attempts reached for sync update:', {
              userId,
              contactId,
              error: error.message
            });
          } else {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
          }
        }
      }
    } catch (error) {
      logger.error('[SyncManager] Error emitting sync update:', {
        error: error.message,
        userId,
        contactId
      });
    }
  },

  startSync: (userId, contactId) => {
    const key = `${userId}-${contactId}`;
    if (!activeSyncs.has(key)) {
      const syncData = {
        status: 'syncing',
        startTime: Date.now(),
        lastUpdated: Date.now(),
        progress: {
          current: 0,
          total: 0,
          percentage: 0,
          status: 'Initializing sync...'
        }
      };
      activeSyncs.set(key, syncData);
      
      SyncManager._emitSyncUpdate(userId, contactId, {
        status: 'syncing',
        progress: syncData.progress
      });
    }
    return activeSyncs.get(key);
  },
  
  getStatus: (userId, contactId) => {
    const key = `${userId}-${contactId}`;
    return activeSyncs.get(key);
  },
  
  updateProgress: (userId, contactId, progress) => {
    const key = `${userId}-${contactId}`;
    const sync = activeSyncs.get(key);
    if (sync) {
      sync.progress = {
        current: progress.current,
        total: progress.total,
        percentage: Math.round((progress.current / progress.total) * 100),
        status: progress.status || 'Syncing messages...'
      };
      
      // Emit progress update
      SyncManager._emitSyncUpdate(userId, contactId, {
        status: 'syncing',
        progress: sync.progress
      });
    }
    return sync;
  },
  
  completeSync: (userId, contactId, success = true) => {
    const key = `${userId}-${contactId}`;
    const sync = activeSyncs.get(key);
    if (sync) {
      sync.status = success ? 'completed' : 'failed';
      if (success && sync.progress) {
        sync.progress.percentage = 100;
        sync.progress.status = 'Sync completed';
      }
      
      // Emit completion status
      SyncManager._emitSyncUpdate(userId, contactId, {
        status: sync.status,
        progress: sync.progress,
        error: !success ? 'Sync failed' : undefined
      });

      // Cleanup after delay
      setTimeout(() => {
        activeSyncs.delete(key);
        // Emit final cleanup status
        SyncManager._emitSyncUpdate(userId, contactId, {
          status: 'idle',
          progress: null
        });
      }, 5000);
    }
    return sync;
  },
  
  cleanupStaleSync: () => {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, sync] of activeSyncs.entries()) {
      // Check both start time and last update time
      const timeSinceStart = now - sync.startTime;
      const timeSinceUpdate = now - (sync.lastUpdated || sync.startTime);

      if (timeSinceStart > SYNC_TIMEOUT || timeSinceUpdate > SYNC_TIMEOUT / 2) {
        const [userId, contactId] = key.split('-');
        
        // Emit timeout status before cleanup
        SyncManager._emitSyncUpdate(userId, parseInt(contactId), {
          status: 'failed',
          error: 'Sync timeout',
          progress: sync.progress
        });

        activeSyncs.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`[SyncManager] Cleaned up ${cleaned} stale sync(s)`);
    }
  }
};

// Start cleanup interval when module loads
SyncManager.startCleanupInterval();

// Cleanup on process exit
process.on('SIGTERM', () => SyncManager.stopCleanupInterval());
process.on('SIGINT', () => SyncManager.stopCleanupInterval());

// Apply authentication middleware
router.use(authenticateUser);

// Get all WhatsApp contacts
router.get('/contacts', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('[Contacts] Fetching contacts for user:', userId);

    // Get cached contacts first for immediate response
    const cachedContacts = await whatsappEntityService.getCachedContacts(userId);
    
    // Start background sync if needed
    const lastSyncTime = await whatsappEntityService.getLastContactSyncTime(userId);
    const SYNC_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    
    if (!lastSyncTime || Date.now() - lastSyncTime > SYNC_THRESHOLD_MS) {
      console.log('[Contacts] Starting background sync for user:', userId);
      whatsappEntityService.syncContacts(userId).catch(error => {
        console.error('[Contacts] Background sync failed:', error);
      });
    }

    // Transform contacts for consistent response
    const transformedContacts = (cachedContacts || []).map(contact => {
      // Extract priority-related fields from metadata if they exist
      const priorityInfo = contact.metadata?.priority_info || {};
      
      return {
        id: contact.id,
        whatsapp_id: contact.whatsapp_id,
        display_name: contact.display_name || contact.whatsapp_id,
        avatar_url: contact.profile_photo_url || null,
        last_message: contact.metadata?.last_message?.content || '',
        last_message_at: contact.last_message_at || null,
        unread_count: contact.unread_count || 0,
        priority: contact.priority || priorityInfo.priority || null,
        last_analysis_at: contact.last_analysis_at || priorityInfo.last_analysis_at || null,
        is_group: contact.is_group || false,
        sync_status: contact.sync_status || 'pending'
      };
    });

    return res.json({
      status: 'success',
      data: transformedContacts,
      meta: {
        sync_info: {
          last_sync: lastSyncTime,
          is_syncing: lastSyncTime === null
        }
      }
    });

  } catch (error) {
    console.error('[Contacts] Error fetching contacts:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch contacts',
      details: error.message
    });
  }
});

// Get single contact details
router.get('/contacts/:contactId', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;

    console.log('[WhatsApp Contact Route] Fetching contact details:', {
      userId,
      contactId
    });

    const { data: contact, error } = await adminClient
      .from('whatsapp_contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('id', parseInt(contactId))
      .single();

    if (error) throw error;
    if (!contact) {
      return res.status(404).json({
        status: 'error',
        message: 'Contact not found'
      });
    }

    res.json({
      status: 'success',
      data: contact
    });
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Request sync for a contact
router.post('/contacts/:contactId/sync', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { force } = req.query;

    // Check if sync is already in progress
    const activeSync = SyncManager.getStatus(userId, parseInt(contactId));
    if (activeSync && !force) {
      return res.json({
        status: 'success',
        data: {
          sync_status: {
            status: activeSync.status,
            progress: activeSync.progress
          }
        }
      });
    }

    // Start new sync
    logger.info('[WhatsApp Sync Route] Initiating sync for contact:', contactId);
    const syncInfo = SyncManager.startSync(userId, parseInt(contactId));

    // Trigger sync in background
    whatsappEntityService.syncMessages(userId, parseInt(contactId))
      .then(() => {
        SyncManager.completeSync(userId, parseInt(contactId), true);
      })
      .catch(error => {
        logger.error('[WhatsApp Sync Route] Sync failed:', {
          error: error.message,
          stack: error.stack,
          userId,
          contactId
        });
        SyncManager.completeSync(userId, parseInt(contactId), false);
      });

    // Return immediately with sync started status
    res.json({
      status: 'success',
      data: {
        sync_status: {
          status: syncInfo.status,
          progress: syncInfo.progress
        }
      }
    });

  } catch (error) {
    logger.error('[WhatsApp Sync Route] Error:', {
      error: error.message,
      stack: error.stack,
      userId: req.user.id,
      contactId: req.params.contactId
    });
    
    return res.status(500).json({
      status: 'error',
      message: 'Failed to start sync',
      details: error.message
    });
  }
});

// Get messages for a contact
router.get('/contacts/:contactId/messages', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    logger.info('[Messages] Fetching messages:', { userId, contactId, page, limit });

    // Get messages with pagination
    const messages = await whatsappEntityService.getMessages(userId, contactId, {
      page: parseInt(page),
      limit: parseInt(limit)
    });

    // Get sync status from manager
    const syncInfo = SyncManager.getStatus(userId, parseInt(contactId));

    // If no messages and no sync in progress, trigger a sync
    if (messages.length === 0 && (!syncInfo || syncInfo.status === 'idle')) {
      logger.info('[Messages] No messages found, triggering sync');
      try {
        const syncResult = await matrixWhatsAppService.syncMessages(userId, contactId);
        logger.info('[Messages] Sync triggered:', syncResult);
        
        // Get messages again after sync
        const updatedMessages = await whatsappEntityService.getMessages(userId, contactId, {
          page: parseInt(page),
          limit: parseInt(limit)
        });
        
        // Transform messages for consistent response
        const transformedMessages = updatedMessages.map(msg => ({
          id: msg.id,
          content: msg.content,
          timestamp: msg.timestamp,
          direction: msg.direction,
          status: msg.status || 'unknown',
          media_url: msg.media_url || null,
          media_type: msg.media_type || null
        }));

        return res.json({
          status: 'success',
          data: {
            messages: transformedMessages,
            status: 'syncing',
            total: null,
            sync_info: { status: 'syncing' },
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              has_more: transformedMessages.length === parseInt(limit)
            }
          }
        });
      } catch (syncError) {
        logger.error('[Messages] Sync error:', {
          error: syncError.message,
          stack: syncError.stack,
          userId,
          contactId
        });
      }
    }

    // Transform messages for consistent response
    const transformedMessages = messages.map(msg => ({
      id: msg.id,
      content: msg.content,
      timestamp: msg.timestamp,
      direction: msg.direction,
      status: msg.status || 'unknown',
      media_url: msg.media_url || null,
      media_type: msg.media_type || null
    }));

    // Get total message count
    const { data: totalCount } = await adminClient
      .from('whatsapp_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('contact_id', contactId);

    return res.json({
      status: 'success',
      data: {
        messages: transformedMessages,
        status: syncInfo?.status || 'idle',
        total: totalCount,
        sync_info: syncInfo || { status: 'idle' },
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          has_more: messages.length === parseInt(limit)
        }
      }
    });

  } catch (error) {
    logger.error('[Messages] Error fetching messages:', {
      error: error.message,
      stack: error.stack,
      userId: req.user.id,
      contactId: req.params.contactId,
      page: req.query.page,
      limit: req.query.limit
    });

    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch messages',
      details: error.message,
      sync_info: { status: 'error' }
    });
  }
});

// Update sync status
router.put('/contacts/:contactId/sync', validateRequest(['contactId', 'status']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Must be "approved" or "rejected"'
      });
    }

    const result = await whatsappEntityService.updateSyncStatus(userId, parseInt(contactId), status);
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error updating sync status:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Mark messages as read
router.post('/contacts/:contactId/messages/read', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { messageIds } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'messageIds must be a non-empty array'
      });
    }

    const result = await whatsappEntityService.markMessagesAsRead(userId, parseInt(contactId), messageIds);
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Accept contact invitation
router.post('/contacts/:contactId/accept', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;

    console.log('Authenticated user:', {
      id: userId,
      email: req.user.email,
      path: req.path,
      method: req.method
    });

    // Get contact details first
    const { data: contact, error: contactError } = await adminClient
      .from('whatsapp_contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('id', parseInt(contactId))
      .single();

    if (contactError) throw contactError;
    if (!contact) {
      return res.status(404).json({
        status: 'error',
        message: 'Contact not found'
      });
    }

    // Verify contact is in 'invite' state
    if (contact.metadata?.membership !== 'invite') {
      return res.status(400).json({
        status: 'error',
        message: 'Contact is not in invite state'
      });
    }

    // Update contact status to reflect user acceptance
    const { error: updateError } = await adminClient
      .from('whatsapp_contacts')
      .update({
        metadata: {
          ...contact.metadata,
          membership: 'join',
          last_action: 'invite_accepted',
          last_action_timestamp: new Date().toISOString()
        }
      })
      .eq('id', parseInt(contactId))
      .eq('user_id', userId);

    if (updateError) throw updateError;

    res.json({
      status: 'success',
      data: {
        message: 'Invitation accepted successfully'
      }
    });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get sync status for a contact
router.get('/contacts/:contactId/sync-status', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;

    console.log('[WhatsApp Service] Checking sync status:', {
      userId,
      contactId
    });

    // Get contact with sync status
    const { data: contact, error } = await adminClient
      .from('whatsapp_contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('id', parseInt(contactId))
      .single();

    if (error) throw error;
    if (!contact) {
      return res.status(404).json({
        status: 'error',
        message: 'Contact not found'
      });
    }

    res.json({
      status: 'success',
      data: {
        sync_status: contact.sync_status,
        metadata: contact.metadata
      }
    });
  } catch (error) {
    console.error('Error checking sync status:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

export default router; 