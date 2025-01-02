// backend/models/Message.js
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  platform: {
    type: String,
    required: true,
    enum: ['matrix', 'whatsapp', 'telegram']
  },
  roomId: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  bridged: {
    type: Boolean,
    default: false
  },
  bridgeSource: String,
  bridgeTarget: String,
  synced: {
    type: Boolean,
    default: false
  }
});

export default mongoose.model('Message', messageSchema);
