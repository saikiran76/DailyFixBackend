import express from 'express';
import { aiAnalysisService } from '../services/aiAnalysisService.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticateUser);

// Get realtime summary (Summarize button)
router.get('/summary/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { limit } = req.query;
    const userId = req.user.id;

    console.log('Fetching realtime summary', { userId, contactId, limit });
    
    const summary = await aiAnalysisService.getRealtimeSummary(
      userId, 
      contactId,
      limit ? parseInt(limit) : undefined
    );
    
    if (!summary) {
      return res.status(404).json({ 
        error: 'No messages found for summary' 
      });
    }
    
    res.json(summary);
  } catch (error) {
    console.error('Error fetching realtime summary', error);
    res.status(500).json({ 
      error: 'Failed to fetch realtime summary' 
    });
  }
});

// Get conversation analysis (AI Analysis button)
router.get('/analysis/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const userId = req.user.id;
    const { initialize } = req.query;

    console.log('Fetching conversation analysis', { userId, contactId, initialize });

    // If initialize flag is set, try to initialize first
    if (initialize === 'true') {
      await aiAnalysisService.initializeContactAnalysis(userId, contactId);
    }
    
    const analysis = await aiAnalysisService.getConversationAnalysis(userId, contactId);
    
    if (!analysis) {
      return res.status(404).json({ 
        error: 'No messages found for analysis' 
      });
    }
    
    res.json(analysis);
  } catch (error) {
    console.error('Error fetching conversation analysis', error);
    res.status(500).json({ 
      error: 'Failed to fetch conversation analysis' 
    });
  }
});

// Update contact priority (Prioritize button)
router.post('/priority/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { priority } = req.body;
    const userId = req.user.id;

    if (!priority || !['HIGH', 'MEDIUM', 'LOW'].includes(priority.toUpperCase())) {
      return res.status(400).json({ 
        error: 'Valid priority (HIGH/MEDIUM/LOW) is required' 
      });
    }

    const priorityValue = priority.toUpperCase();
    console.log('Updating contact priority', { userId, contactId, priority: priorityValue });
    
    // Update contact priority
    const { error: contactError } = await adminClient
      .from('whatsapp_contacts')
      .update({ 
        priority: priorityValue,
        last_analysis_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('id', parseInt(contactId));

    if (contactError) throw contactError;

    // Update latest summary priority if it exists
    const { error: summaryError } = await adminClient
      .from('message_summaries')
      .update({ 
        priority: priorityValue,
        is_ai_suggested: false, // Mark as manually set
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('contact_id', parseInt(contactId))
      .eq('date', new Date().toISOString().split('T')[0]); // Update today's summary if it exists

    // Note: We don't throw on summaryError since it's optional (might not exist for today)
    
    res.json({ 
      success: true,
      priority: priorityValue
    });
  } catch (error) {
    console.error('Error updating contact priority', error);
    res.status(500).json({ 
      error: 'Failed to update contact priority' 
    });
  }
});

// Get historical summary
router.post('/summary/:contactId/historical', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { date } = req.body;
    const userId = req.user.id;

    if (!date) {
      return res.status(400).json({ 
        error: 'Date is required' 
      });
    }

    console.log('Generating historical summary', { userId, contactId, date });
    
    const summary = await aiAnalysisService.generateHistoricalSummary(
      userId,
      contactId, 
      new Date(date)
    );
    
    if (!summary) {
      return res.status(404).json({ 
        error: 'No messages found for summary generation' 
      });
    }
    
    res.json({ 
      summary,
      date 
    });
  } catch (error) {
    console.error('Error generating historical summary', error);
    res.status(500).json({ 
      error: 'Failed to generate historical summary' 
    });
  }
});

// Get latest AI-suggested priority for a contact
router.get('/priority/suggested/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const userId = req.user.id;

    console.log('Fetching suggested priority', { userId, contactId });
    
    // First try to get existing priority
    const priority = await aiAnalysisService.getLatestSuggestedPriority(userId, contactId);
    
    // If no priority exists, initialize a new analysis
    if (!priority) {
      console.log('No existing priority found, initializing analysis', { userId, contactId });
      const result = await aiAnalysisService.initializeContactAnalysis(userId, contactId);
      return res.json({ 
        suggestedPriority: result.priority,
        isAiSuggested: true,
        wasInitialized: true
      });
    }
    
    res.json({ 
      suggestedPriority: priority,
      isAiSuggested: true,
      wasInitialized: false
    });
  } catch (error) {
    console.error('Error fetching suggested priority', error);
    res.status(500).json({ 
      error: 'Failed to fetch suggested priority' 
    });
  }
});

// Initialize contact analysis
router.post('/initialize/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { force } = req.query;
    const userId = req.user.id;

    console.log('Initializing contact analysis', { userId, contactId, force });
    
    const result = await aiAnalysisService.initializeContactAnalysis(userId, contactId, force === 'true');
    
    res.json(result);
  } catch (error) {
    console.error('Error initializing contact analysis', error);
    res.status(500).json({ 
      error: 'Failed to initialize contact analysis' 
    });
  }
});

export default router; 