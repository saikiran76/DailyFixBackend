import express from 'express';

import Message from '../models/Message.js';
// import { authenticateToken } from '../middleware/auth.js'; removed middleware for a while
import { getRoomMessages, getRoomSummary, getCustomerDetails, sendMessage, calculateMessagePriority, categorizeMessage, analyzeSentiment,generateMessageSummary, extractKeyTopics } from '../services/matrixService.js';

const router = express.Router();

// Debug middleware to log Matrix client state
const logMatrixState = (req, res, next) => {
  const client = req.app.locals.matrixClient;
  console.log('Matrix Client State:', {
    initialized: !!client,
    syncState: client?.getSyncState(),
    accessToken: !!client?.getAccessToken(),
    userId: client?.getUserId()
  });
  next();
};

router.use(logMatrixState);

// Get all rooms
router.get('/',  async (req, res) => {
  try {
    const client = req.app.locals.matrixClient;
    
    if (!client) {
      throw new Error('Matrix client not initialized');
    }

    console.log('Fetching rooms...');
    const syncState = client.getSyncState();
    console.log('Current sync state:', syncState);

    // Enhanced sync check with timeout
    if (!client.isInitialSyncComplete()) {
      console.log('Waiting for initial sync...');
      await Promise.race([
        new Promise(resolve => {
          client.once('sync', (state) => {
            console.log('Sync state changed to:', state);
            if (state === 'PREPARED') resolve();
          });
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Sync timeout')), 10000)
        )
      ]);
    }

    const rooms = client.getRooms();
    console.log(`Found ${rooms.length} rooms`);

    const roomList = rooms.map(room => {
      const timeline = room.timeline || [];
      const lastEvent = timeline[timeline.length - 1];
      
      return {
        id: room.roomId,
        name: room.name || 'Unnamed Room',
        lastMessage: lastEvent?.getContent()?.body || '',
        status: room.getJoinedMemberCount() > 1 ? 'active' : 'inactive',
        assignee: '@ksk76:matrix.org',
        lastActive: lastEvent?.getDate() || new Date(),
        isActive: room.getJoinedMemberCount() > 1,
        memberCount: room.getJoinedMemberCount()
      };
    });

    res.json(roomList);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
    });
  }
});

// Get messages for a specific room
router.get('/:roomId/messages',  async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50 } = req.query;

    // Fetch messages from DB
    const msgs = await Message.find({ roomId, platform: 'matrix' })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();

    // Reverse to oldest first if needed
    const messages = msgs.reverse().map(m => ({
      id: m._id.toString(),
      content: m.content,
      sender: m.sender,
      senderName: m.senderName,
      timestamp: m.timestamp.getTime(),
      priority: m.priority
    }));

    res.json({ messages, roomId });
  } catch (error) {
    console.error('Error fetching room messages:', error);
    res.status(500).json({ error: error.message });
  }
});


// Get customer details with enhanced error handling
router.get('/:roomId/customer',  async (req, res) => {
  try {
    const { roomId } = req.params;
    const client = req.app.locals.matrixClient;
    
    console.log(`Fetching customer details for room ${roomId}`);

    if (!client) {
      throw new Error('Matrix client not initialized');
    }

    const room = client.getRoom(roomId);
    if (!room) {
      console.log(`Room ${roomId} not found`);
      return res.status(404).json({ error: 'Room not found' });
    }

    const members = room.getJoinedMembers();
    console.log(`Found ${members.length} members in room`);

    const customer = members.find(member => 
      member.userId !== client.getUserId() && 
      !member.userId.includes(':bot.')
    );

    if (!customer) {
      console.log('No customer found in room');
      return res.status(404).json({ error: 'No customer found in room' });
    }

    const customerDetails = {
      userId: customer.userId,
      displayName: customer.name || customer.userId,
      avatarUrl: customer.avatarUrl,
      joinedAt: room.getMember(customer.userId)?.events?.member?.getDate(),
      notes: '',
      tags: [],
      customFields: {}
    };

    console.log('Customer details:', customerDetails);
    res.json(customerDetails);
  } catch (error) {
    console.error('Error fetching customer details:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
    });
  }
});

// Get room summary
router.get('/:roomId/summary',  async (req, res) => {
  try {
    const { roomId } = req.params;
    const client = req.app.locals.matrixClient;

    console.log('Fetching summary for room:', roomId);
    console.log('Matrix client status:', client ? 'initialized' : 'not initialized');

    if (!client) {
      throw new Error('Matrix client not initialized');
    }

    // Decode the room ID
    const decodedRoomId = decodeURIComponent(roomId);
    console.log('Decoded room ID:', decodedRoomId);

    // Get room summary
    const summary = await getRoomSummary(client, decodedRoomId);
    console.log('Summary generated successfully');

    res.json(summary);
  } catch (error) {
    console.error('Detailed error in room summary route:', {
      message: error.message,
      stack: error.stack,
      roomId: req.params.roomId
    });

    res.status(500).json({ 
      error: 'Failed to fetch room summary',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add a debug endpoint
router.get('/debug/client',  (req, res) => {
  const client = req.app.locals.matrixClient;
  res.json({
    clientInitialized: !!client,
    syncState: client?.getSyncState(),
    userId: client?.getUserId(),
    roomCount: client?.getRooms()?.length || 0,
    accessTokenPresent: !!client?.getAccessToken()
  });
});

// Example snippet for matrix message sending route (assuming something like '/rooms/:roomId/messages')
router.post('/:roomId/messages',  async (req, res) => {
  try {
    const { roomId } = req.params;
    const { content, priority } = req.body;
    const client = req.app.locals.matrixClient;

    if (!client) {
      throw new Error('Matrix client not initialized');
    }

    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const finalPriority = priority || 'medium';

    // Send the message to Matrix
    const response = await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: content
    });

    // response.event_id and client.getUserId() for sender ID
    const sender = client.getUserId(); 
    const newMessage = new Message({
      content,
      sender,
      senderName: sender, // Or fetch a display name if needed
      priority: finalPriority,
      platform: 'matrix',
      roomId: roomId,
      timestamp: new Date()
    });
    await newMessage.save();

    res.json({
      success: true,
      eventId: response.event_id,
      content: content,
      timestamp: newMessage.timestamp.getTime(),
      priority: finalPriority
    });
  } catch (error) {
    console.error('Failed to send message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Adjust your `sendMessage` function to NOT calculate priority:
// Just send the message and return the bare message data.
async function sendMessageWithoutPriorityCalc(client, roomId, content) {
  const response = await client.sendMessage(roomId, {
    msgtype: 'm.text',
    body: content
  });

  return {
    eventId: response.event_id,
    content,
    sender: client.getUserId(),
    timestamp: Date.now(),
    type: 'm.room.message'
  };
}


router.get('/:roomId/conversation-summary',  async (req, res) => {
  try {
    const { roomId } = req.params;
    const client = req.app.locals.matrixClient;

    if (!client) {
      throw new Error('Matrix client not initialized');
    }

    const messages = await getRoomMessages(client, decodeURIComponent(roomId));
    
    if (!messages || !Array.isArray(messages)) {
      throw new Error('Invalid messages data received');
    }

    const formattedMessages = messages.map(msg => ({
      getContent: () => ({ body: msg.content || '' }),
      getSender: () => msg.sender,
      getDate: () => new Date(msg.timestamp)
    }));

    const summary = {
      messageCount: messages.length,
      keyTopics: extractKeyTopics(formattedMessages),
      priorityBreakdown: {
        high: messages.filter(m => m.priority === 'high').length,
        medium: messages.filter(m => m.priority === 'medium').length,
        low: messages.filter(m => m.priority === 'low').length
      },
      sentimentAnalysis: messages.reduce((acc, msg) => {
        const sentiment = analyzeSentiment(msg.content || '');
        acc[sentiment] = (acc[sentiment] || 0) + 1;
        return acc;
      }, {}),
      categories: messages.reduce((acc, msg) => {
        const category = categorizeMessage(msg.content || '');
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {})
    };

    res.json(summary);
  } catch (error) {
    console.error('Error generating conversation summary:', error);
    res.status(500).json({ 
      error: 'Failed to generate conversation summary',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.post('/:roomId/batch-analyze',  async (req, res) => {
  try {
    const { messages } = req.body;
    const client = req.app.locals.matrixClient;
    const batchResults = [];
    const batchSize = 5;

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const batchPromises = batch.map(msg => generateMessageSummary(msg.content));
      const batchAnalysis = await Promise.all(batchPromises);
      batchResults.push(...batchAnalysis);
    }

    res.json({
      results: batchResults,
      totalProcessed: batchResults.length
    });
  } catch (error) {
    console.error('Error in batch analysis:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;