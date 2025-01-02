import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { searchMessages } from '../services/matrixService.js';

const createSearchRouter = (client) => {
  const router = express.Router();

  // Search messages across rooms
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const { term, page = 1, limit = 10 } = req.query;

      if (!term) {
        return res.status(400).json({ 
          error: 'Search term is required' 
        });
      }

      const searchResults = await searchMessages(client, term, parseInt(page), parseInt(limit));
      res.json(searchResults);
    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Search rooms
  router.get('/rooms', authenticateToken, async (req, res) => {
    try {
      const rooms = client.getRooms();
      const roomList = rooms.map(room => ({
        id: room.roomId,
        name: room.name,
        memberCount: room.getJoinedMemberCount(),
        lastMessage: room.timeline[room.timeline.length - 1]?.getContent()?.body || '',
        lastActivity: room.timeline[room.timeline.length - 1]?.getDate() || null,
        isActive: room.timeline.length > 0 && 
          (Date.now() - new Date(room.timeline[room.timeline.length - 1]?.getDate()).getTime()) < 3600000 // Active if message within last hour
      }));

      res.json(roomList);
    } catch (error) {
      console.error('Room search error:', error);
      res.status(500).json({ error: 'Room search failed' });
    }
  });

  // Search users in a room
  router.get('/room/:roomId/users', authenticateToken, async (req, res) => {
    try {
      const { roomId } = req.params;
      const room = client.getRoom(roomId);

      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      const members = room.getJoinedMembers();
      const userList = members.map(member => ({
        id: member.userId,
        name: member.name,
        avatarUrl: member.avatarUrl,
        isActive: member.presence === 'online'
      }));

      res.json(userList);
    } catch (error) {
      console.error('User search error:', error);
      res.status(500).json({ error: 'User search failed' });
    }
  });

  // Get room messages with pagination
  router.get('/room/:roomId/messages', authenticateToken, async (req, res) => {
    try {
      const { roomId } = req.params;
      const { limit = 50, before } = req.query;
      const room = client.getRoom(roomId);

      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      let messages;
      if (before) {
        messages = await client.scrollback(room, parseInt(limit), before);
      } else {
        messages = room.timeline
          .slice(-parseInt(limit))
          .map(event => ({
            id: event.getId(),
            content: event.getContent().body,
            sender: event.getSender(),
            timestamp: event.getDate(),
            type: event.getType()
          }));
      }

      res.json({
        messages,
        roomName: room.name,
        memberCount: room.getJoinedMemberCount()
      });
    } catch (error) {
      console.error('Message fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  return router;
};

export default createSearchRouter;