import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { whatsappEntityService } from '../services/whatsappEntityService.js';
import { validateRequest } from '../middleware/validation.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateUser);

// Get all WhatsApp contacts
router.get('/contacts', async (req, res) => {
  try {
    const userId = req.user.id;
    const contacts = await whatsappEntityService.getContacts(userId);
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

    const messages = await whatsappEntityService.getMessages(
      userId,
      parseInt(contactId),
      limit ? parseInt(limit) : undefined,
      before
    );

    res.json({
      status: 'success',
      data: messages
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(error.message.includes('not approved') ? 403 : 500).json({
      status: 'error',
      message: error.message
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
router.put('/contacts/:contactId/messages/read', validateRequest(['contactId', 'messageIds']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { messageIds } = req.body;

    if (!Array.isArray(messageIds)) {
      return res.status(400).json({
        status: 'error',
        message: 'messageIds must be an array'
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