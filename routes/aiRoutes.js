import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { voiceToText } from '../services/sttService.js';

const router=express.Router();
router.use(authenticateToken);

router.post('/voiceToText', async (req,res)=>{
  // Expect audio data in req.body.audio (base64 or similar)
  const { audio } = req.body;
  if(!audio) return res.status(400).json({error:'No audio provided'});
  try {
    const result=await voiceToText(audio);
    res.json(result);
  } catch(err) {
    console.error('STT error:',err);
    res.status(500).json({error:'STT failed'});
  }
});

export default router;
