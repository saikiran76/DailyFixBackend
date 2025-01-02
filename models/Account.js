import mongoose from 'mongoose';

const accountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  platform: { type: String, enum: ['matrix', 'slack', 'whatsapp', 'telegram'], required: true },
  credentials: { type: Object, default: {} },
  connectedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
});

accountSchema.index({ userId: 1, platform: 1 }, { unique: true });

export default mongoose.model('Account', accountSchema);
