// backend/models/Rules.js
import mongoose from 'mongoose';

/*
Stores user-defined rules for prioritizing messages and automating responses.
Example rule structure:
{
  userId: ObjectId,
  conditions: [
    { field: 'content', op: 'contains', value: 'urgent' },
    { field: 'platform', op: 'equals', value: 'whatsapp' }
  ],
  actions: {
    priority: 'high',
    autoRespond: true,
    autoResponseText: 'Received your urgent message, will respond ASAP.'
  }
}
*/

const rulesSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conditions: { type: Array, default: [] },
  actions: { type: Object, default: {} }
});

export default mongoose.model('Rules', rulesSchema);
