import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
// import { 
//   initializeDiscordClient, 
//   getDiscordClient 
// } from '../services/discordService.js'
import Message from '../models/Message.js';

const router = express.Router();

// Get all Discord channels
router.get('/channels', authenticateToken, async (req, res) => {
  try {
    const client = req.app.locals.discordClient;
    const channels = client.channels.cache
      .filter(channel => channel.type === 0) // Text channels
      .map(channel => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        memberCount: channel.members.size,
        createdAt: channel.createdAt,
        isActive: true
      }));

    res.json(channels);
  } catch (error) {
    console.error('Error fetching Discord channels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a specific Discord channel
router.get('/channels/:channelId/messages', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { limit = 50 } = req.query;

    // Fetch messages from DB
    const msgs = await Message.find({ 
      roomId: channelId, 
      platform: 'discord' 
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

    res.json({ messages, channelId });
  } catch (error) {
    console.error('Error fetching Discord channel messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send a message to a Discord channel
router.post('/channels/:channelId/messages', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { content, priority } = req.body;
    const client = req.app.locals.discordClient;

    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const finalPriority = priority || 'medium';

    // Send message to Discord
    const message = await channel.send(content);

    // Save to database
    const newMessage = new Message({
      content,
      sender: message.author.id,
      senderName: message.author.username,
      priority: finalPriority,
      platform: 'discord',
      roomId: channelId,
      timestamp: new Date()
    });
    await newMessage.save();

    res.json({
      success: true,
      eventId: message.id,
      content: content,
      timestamp: newMessage.timestamp.getTime(),
      priority: finalPriority
    });
  } catch (error) {
    console.error('Failed to send Discord message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get Discord channel summary
router.get('/channels/:channelId/summary', authenticateToken, async (req, res) => {
  try {
    const { channelId } = req.params;
    const client = req.app.locals.discordClient;

    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Fetch messages
    const messages = await channel.messages.fetch({ limit: 50 });

    const summary = {
      channelId,
      channelName: channel.name,
      messageCount: messages.size,
      keyTopics: extractKeyTopics(
        messages.map(m => ({ 
          getContent: () => ({ body: m.content }), 
          getSender: () => m.author.id 
        }))
      ),
      priorityBreakdown: {
        high: messages.filter(m => calculateMessagePriority(m) === 'high').size,
        medium: messages.filter(m => calculateMessagePriority(m) === 'medium').size,
        low: messages.filter(m => calculateMessagePriority(m) === 'low').size
      },
      sentimentAnalysis: analyzeSentiment(
        messages.map(m => m.content).join(' ')
      ),
      categories: messages.reduce((acc, msg) => {
        const category = categorizeMessage(msg.content);
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {})
    };

    res.json(summary);
  } catch (error) {
    console.error('Error generating Discord channel summary:', error);
    res.status(500).json({ 
      error: 'Failed to generate channel summary',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;