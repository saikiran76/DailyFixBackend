import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { whatsappEntityService } from '../services/whatsappEntityService.js';
import { validateRequest } from '../middleware/validation.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateUser);

// Get all WhatsApp contacts
router.get('/contacts', async (req, res) => {
  try {
    const userId = req.user.id;
    const { force } = req.query;

    console.log('[WhatsApp Contacts Route] Fetching contacts:', {
      userId,
      forceSync: force === 'true'
    });

    const contacts = await whatsappEntityService.getContacts(userId, force === 'true');
    res.json({
      status: 'success',
      data: contacts
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
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

    const syncRequest = await whatsappEntityService.requestSync(userId, parseInt(contactId));
    res.json({
      status: 'success',
      data: syncRequest
    });
  } catch (error) {
    console.error('Error requesting sync:', error);
    res.status(error.message.includes('not found') ? 404 : 500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get messages for a contact
router.get('/contacts/:contactId/messages', validateRequest(['contactId']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { limit, before } = req.query;

    console.log('[WhatsApp Messages Route] Received request:', {
      method: req.method,
      url: req.url,
      params: req.params,
      query: req.query,
      headers: {
        ...req.headers,
        authorization: req.headers.authorization ? '[REDACTED]' : undefined
      },
      userId,
      contactId
    });

    // Validate parameters
    if (!userId || !contactId) {
      console.error('[WhatsApp Messages Route] Missing required parameters:', { userId, contactId });
      return res.status(400).json({
        status: 'error',
        message: 'Missing required parameters'
      });
    }

    console.log('[WhatsApp Messages Route] Calling getMessages service');
    const messages = await whatsappEntityService.getMessages(
      userId,
      parseInt(contactId),
      limit ? parseInt(limit) : undefined,
      before
    );

    console.log(`[WhatsApp Messages Route] Service response:`, {
      messageCount: messages?.length || 0,
      firstMessageTimestamp: messages?.[0]?.timestamp,
      lastMessageTimestamp: messages?.[messages?.length - 1]?.timestamp
    });

    res.json({
      status: 'success',
      data: messages
    });
  } catch (error) {
    console.error('[Messages Route] Error:', error);
    console.error('[Messages Route] Stack:', error.stack);
    res.status(error.message.includes('not approved') ? 403 : 500).json({
      status: 'error',
      message: error.message,
      details: error.stack
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

export default router; 