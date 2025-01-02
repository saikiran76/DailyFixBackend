import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { createMatrixRoom, getMatrixRooms } from '../services/matrixService.js';
import ChannelMapping from '../models/ChannelMapping.js';

const router = express.Router();
router.use(authMiddleware);

// Create new Matrix room and map it to platform channel
router.post('/rooms/map', async (req, res) => {
  const userId = req.user?._id;
  const { platform, channelId, roomName } = req.body;

  try {
    const room = await createMatrixRoom(userId, platform, roomName);
    
    // Create channel mapping
    await ChannelMapping.create({
      userId,
      sourceChannelId: channelId,
      sourcePlatform: platform,
      targetChannelId: room.room_id,
      targetPlatform: 'matrix'
    });

    // Reference existing initializeBridge function
    startLine: 11
    endLine: 69

    res.json({
      status: 'success',
      room: {
        id: room.room_id,
        name: roomName
      }
    });
  } catch (error) {
    console.error('Room mapping error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

export default router; 