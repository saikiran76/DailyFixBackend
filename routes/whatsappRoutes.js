import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
// import { 
//   initializeWhatsAppClient, 
//   getWhatsAppClient 
// } from '../services/whatsappService.js';
import { Message } from '../models/Message.js';

const router = express.Router();

// Get all WhatsApp conversations
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const client = req.app.locals.whatsappClient;
    
    // Fetch recent conversations using Twilio
    const conversations = await client.conversations.conversations.list();

    const normalizedConversations = conversations.map(conv => ({
      id: conv.sid,
      participants: conv.participants.map(p => p.address),
      dateCreated: conv.dateCreated,
      status: conv.state,
      isActive: conv.state === 'active'
    }));

    res.json(normalizedConversations);
  } catch (error) {
    console.error('Error fetching WhatsApp conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a specific WhatsApp conversation
router.get('/conversations/:conversationId/messages', authenticateToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50 } = req.query;

    // Fetch messages from DB
    const msgs = await Message.find({ 
      roomId: conversationId, 
      platform: 'whatsapp' 
    })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();

    const messages = msgs.reverse().map(m => ({
      id: m._id.toString(),
      content: m.content,
      sender: m.sender,
      senderName: m.senderName,
      timestamp: m.timestamp.getTime(),
      priority: m.priority
    }));

    res.json({ messages, conversationId });
  } catch (error) {
    console.error('Error fetching WhatsApp messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send a WhatsApp message
router.post('/conversations/:conversationId/messages', authenticateToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { content, priority } = req.body;
    const client = req.app.locals.whatsappClient;

    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const finalPriority = priority || 'medium';

    // Send WhatsApp message
    const message = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      body: content,
      to: `whatsapp:${conversationId}`
    });

    // Save to database
    const newMessage = new Message({
      content,
      sender: conversationId,
      senderName: conversationId,
      priority: finalPriority,
      platform: 'whatsapp',
      roomId: conversationId,
      timestamp: new Date()
    });
    await newMessage.save();

    res.json({
      success: true,
      eventId: message.sid,
      content: content,
      timestamp: newMessage.timestamp.getTime(),
      priority: finalPriority
    });
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get WhatsApp conversation summary
router.get('/conversations/:conversationId/summary', authenticateToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const client = req.app.locals.whatsappClient;

    // Fetch messages from Twilio
    const messages = await client.messages.list({
      from: `whatsapp:${conversationId}`,
      limit: 50
    });

    const summary = {
      conversationId,
      messageCount: messages.length,
      keyTopics: extractKeyTopics(
        messages.map(m => ({ 
          getContent: () => ({ body: m.body }), 
          getSender: () => m.from 
        }))
      ),
      priorityBreakdown: {
        high: messages.filter(m => calculateMessagePriority(m.body) === 'high').length,
        medium: messages.filter(m => calculateMessagePriority(m.body) === 'medium').length,
        low: messages.filter(m => calculateMessagePriority(m.body) === 'low').length
      },
      sentimentAnalysis: analyzeSentiment(
        messages.map(m => m.body).join(' ')
      ),
      categories: messages.reduce((acc, msg) => {
        const category = categorizeMessage(msg.body);
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {})
    };

    res.json(summary);
  } catch (error) {
    console.error('Error generating WhatsApp conversation summary:', error);
    res.status(500).json({ 
      error: 'Failed to generate conversation summary',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;