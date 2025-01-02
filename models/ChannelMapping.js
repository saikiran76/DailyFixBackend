import mongoose from 'mongoose';

const channelMappingSchema = new mongoose.Schema({
  platform: { type: String, enum: ['slack', 'whatsapp', 'telegram', 'matrix'], required: true },
  roomId: { type: String, required: true },
  team_id: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourcePlatform: { type: String, enum: ['slack', 'whatsapp', 'telegram', 'matrix'], required: true },
  sourceChannelId: { type: String, required: true },
  sourceName: { type: String },
  targetPlatform: { type: String, enum: ['slack', 'whatsapp', 'telegram', 'matrix'], required: true },
  targetChannelId: { type: String, required: true },
  targetName: { type: String },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
});

channelMappingSchema.index({platform:1,roomId:1},{unique:true});

export default mongoose.model('ChannelMapping', channelMappingSchema);
