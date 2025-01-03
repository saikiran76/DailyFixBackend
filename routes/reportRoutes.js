import express from 'express';
import { supabase } from '../utils/supabase.js';
import { generateChannelReport, generateBasicReport } from '../services/aiService.js';
import { getChannelMessages } from '../services/discordService.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticateUser);

// Generate report for a channel
router.post('/discord/channels/:channelId/report', async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    // Fetch today's messages
    const messages = await getChannelMessages(channelId);
    
    if (!messages || messages.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No messages found for today'
      });
    }

    let reportData;
    try {
      // Try AI report generation first
      reportData = await generateChannelReport(messages, channelId);
    } catch (error) {
      console.warn('AI report generation failed, falling back to basic report:', error);
      // Fall back to basic report if AI fails
      reportData = generateBasicReport(messages);
    }

    // Store report in database
    const { data: report, error: dbError } = await supabase
      .from('channel_reports')
      .insert({
        user_id: userId,
        channel_id: channelId,
        report_data: reportData,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (dbError) throw dbError;

    res.json({
      status: 'success',
      data: report
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate report',
      error: error.message
    });
  }
});

// Get reports for a channel
router.get('/discord/channels/:channelId/reports', async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    const { data: reports, error } = await supabase
      .from('channel_reports')
      .select('*')
      .eq('channel_id', channelId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      status: 'success',
      data: reports
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch reports',
      error: error.message
    });
  }
});

export default router;
