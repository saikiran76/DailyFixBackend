import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Message from '../models/Message.js';
import { generateAISummary } from '../services/aiService.js';

const router = express.Router();
router.use(authenticateToken);

router.get('/generate', async (req,res)=>{
  // fetch user messages
  const userId = req.user.id;
  const msgs = await Message.find().sort({timestamp:-1}).limit(100).lean(); // limit 100 for summary

  const aiResult = await generateAISummary(msgs);
  res.json(aiResult);
});

export default router;
