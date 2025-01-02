// backend/routes/slackRoutes.js
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Message from '../models/Message.js';
import Account from '../models/Account.js';
import User from '../models/User.js';
import { getSlackClientForUser, fetchSlackMessagesForUser } from '../services/slackService.js';
import { analyzeSentiment, categorizeMessage, calculateMessagePriority } from '../services/matrixService.js';
import { processSlackEvent, exchangeSlackCodeForToken } from '../services/slackService.js';

const router = express.Router();
router.use(authenticateToken);

// Slack event subscription endpoint:
router.post('/events', async (req,res)=>{
  const {challenge, event, team_id}=req.body;
  if(challenge) return res.send(challenge);
  if(event && team_id) {
    await processSlackEvent(team_id, event);
  }
  res.json({ok:true});
});

router.get('/initiate', async(req,res)=>{
  const userId=req.user.id;
  const state=jwt.sign({userId},process.env.JWT_SECRET,{expiresIn:'10m'});
  const redirect_uri='http://localhost:3001/slack/callback';
  const url=`https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=channels:history,channels:read,chat:write,groups:history,groups:read,im:history,im:read,users:read&user_scope=&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}`;
  res.json({status:'redirect', url});
});

// Slack OAuth callback:
router.get('/callback', async (req,res)=>{
  const {code, state}=req.query;
  try {
    const decoded=jwt.verify(state, process.env.JWT_SECRET);
    const userId=decoded.userId;
    const resp=await exchangeSlackCodeForToken(code);
    if(!resp.ok) {
      console.error('Slack OAuth failed:', resp.error);
      return res.status(500).send('Slack OAuth failed');
    }
    // store in Account:
    let account=await Account.findOne({userId,platform:'slack'});
    const credentials={
      access_token:resp.access_token,
      team_id:resp.team.id,
      team_name:resp.team.name
    };
    if(!account) {
      account=new Account({userId, platform:'slack', credentials});
      await account.save();
    } else {
      account.credentials=credentials;
      await account.save();
    }
    // redirect to dashboard
    res.redirect('http://localhost:5173/dashboard');
  } catch(err) {
    console.error('Slack callback error:', err);
    res.status(500).send('Slack callback failed');
  }
});

// List channels for authenticated user
router.get('/channels', async (req, res) => {
  try {
    const slack = await getSlackClientForUser(req.user._id);
    const response = await slack.conversations.list({
      limit: 100,
      types: 'public_channel,private_channel'
    });

    if (!response.ok) {
      throw new Error('Failed to fetch Slack channels');
    }

    if (!response.channels) {
      return res.json([]);
    }

    const channels = response.channels.map(ch => ({
      id: ch.id,
      name: ch.name,
      isMember: ch.is_member,
      created: new Date(ch.created * 1000),
      isActive: true,
      memberCount: ch.num_members || 0
    }));

    res.json(channels);
  } catch (error) {
    console.error('Error fetching Slack channels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send a message
router.post('/channels/:channelId/messages',  async (req, res) => {
  try {
    const { channelId } = req.params;
    const { content, priority } = req.body;
    const slack = await getSlackClientForUser(req.user._id);

    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const finalPriority = priority || 'medium';

    const response = await slack.chat.postMessage({
      channel: channelId,
      text: content
    });

    if (!response.ok) {
      throw new Error('Failed to send Slack message');
    }

    const sender = response.message.user || 'unknown_user';
    await Message.create({
      content,
      sender,
      senderName: sender,
      priority: finalPriority,
      platform: 'slack',
      roomId: channelId,
      timestamp: new Date()
    });

    res.json({
      success: true,
      eventId: response.ts,
      content,
      timestamp: Date.now(),
      priority: finalPriority
    });
  } catch (error) {
    console.error('Failed to send Slack message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fetch messages for a channel
router.get('/channels/:channelId/messages',  async (req, res) => {
  try {
    const { channelId } = req.params;
    const { limit = 50 } = req.query;

    // Fetch latest Slack messages before returning from DB
    await fetchSlackMessagesForUser(req.user._id, channelId);

    const msgs = await Message.find({ roomId: channelId, platform: 'slack' })
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
    console.error('Error fetching Slack messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Summary
router.get('/channels/:channelId/summary', async (req, res) => {
  try {
    const { channelId } = req.params;
    await fetchSlackMessagesForUser(req.user._id, channelId);

    // Fetch from DB now
    const msgs = await Message.find({ roomId: channelId, platform: 'slack' }).lean();
    const messages = msgs.map(m => ({
      content: m.content,
      sender: m.sender,
      timestamp: m.timestamp.getTime(),
      getContent: () => ({ body: m.content }),
      getSender: () => m.sender,
      getDate: () => new Date(m.timestamp)
    }));

    const keyTopics = [...new Set(messages.flatMap(m => m.getContent().body.toLowerCase().split(/\W+/)))].slice(0,5);
    const priorityBreakdown = {
      high: messages.filter(m => calculateMessagePriority(m, { timeline: [] }) === 'high').length,
      medium: messages.filter(m => calculateMessagePriority(m, { timeline: [] }) === 'medium').length,
      low: messages.filter(m => calculateMessagePriority(m, { timeline: [] }) === 'low').length
    };
    const sentimentAnalysis = messages.reduce((acc, m) => {
      const s = analyzeSentiment(m.getContent().body);
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    const categories = messages.reduce((acc, m) => {
      const c = categorizeMessage(m.getContent().body);
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {});

    const summary = {
      messageCount: messages.length,
      keyTopics,
      priorityBreakdown,
      sentimentAnalysis,
      categories
    };

    res.json(summary);
  } catch (error) {
    console.error('Error generating Slack channel summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// router.post('/events', async (req,res)=>{
//   const {challenge, event, team_id} = req.body;
//   if (challenge) return res.send(challenge);

//   if (event && team_id) {
//     await processSlackEvent(team_id, event);
//   }
//   res.json({ok:true});
// });


export default router;
