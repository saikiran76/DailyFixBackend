import OpenAI from 'openai';
import { adminClient } from '../utils/supabase.js';

class AIAnalysisService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async getRealtimeSummary(userId, contactId, limit = 50) {
    try {
      // Get the most recent N messages
      const { data: messages, error: messagesError } = await adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (messagesError) throw messagesError;

      if (!messages?.length) {
        console.info('No messages found for summary', { userId, contactId });
        return null;
      }

      // Prepare messages for AI analysis
      const messageTexts = messages.reverse().map(msg => {
        let content = msg.content;
        try {
          if (typeof content === 'string' && content.startsWith('{')) {
            const parsed = JSON.parse(content);
            content = parsed.body || parsed.content || content;
          }
        } catch (e) {
          // If parsing fails, use the content as is
        }
        return `[${new Date(msg.timestamp).toLocaleTimeString()}] ${content}`;
      }).join('\n');

      // Generate quick summary using OpenAI
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{
          role: "system",
          content: "You are a helpful assistant that provides quick, concise summaries of recent WhatsApp conversations. Focus on the main points, action items, and key decisions made."
        }, {
          role: "user",
          content: `Please provide a quick summary of these recent messages with:
          1. Main discussion points (2-3 bullet points)
          2. Any immediate action items
          3. Key decisions made (if any)

          Format as a JSON object with these exact fields:
          {
            "mainPoints": string[],
            "actionItems": string[],
            "keyDecisions": string[]
          }

          Messages:
          ${messageTexts}`
        }],
        temperature: 0.7,
        max_tokens: 500,
        response_format: { type: "json_object" }
      });

      const summary = JSON.parse(response.choices[0].message.content);
      
      // Ensure all required fields exist
      const formattedSummary = {
        mainPoints: Array.isArray(summary.mainPoints) ? summary.mainPoints : [],
        actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
        keyDecisions: Array.isArray(summary.keyDecisions) ? summary.keyDecisions : []
      };

      return {
        summary: formattedSummary,
        messageCount: messages.length,
        timespan: {
          start: messages[messages.length - 1].timestamp,  // First message chronologically
          end: messages[0].timestamp  // Last message chronologically
        }
      };

    } catch (error) {
      console.error('Error generating realtime summary', { error, userId, contactId });
      throw error;
    }
  }

  async getConversationAnalysis(userId, contactId) {
    try {
      // Check if contact exists and get current priority
      const { data: contact, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('priority, last_analysis_at')
        .eq('user_id', userId)
        .eq('id', parseInt(contactId))
        .single();

      if (contactError) throw contactError;

      // Get the most recent messages (last 50)
      const { data: messages, error: messagesError } = await adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .limit(50);

      if (messagesError) throw messagesError;

      if (!messages?.length) {
        console.info('No messages found for analysis', { userId, contactId });
        return {
          suggestedPriority: 'LOW',  // Default to LOW for new contacts
          confidence: 1.0,
          reason: 'No messages available for analysis'
        };
      }

      // Prepare messages for AI analysis
      const messageTexts = messages.reverse().map(msg => {
        let content = msg.content;
        try {
          if (typeof content === 'string' && content.startsWith('{')) {
            const parsed = JSON.parse(content);
            content = parsed.body || parsed.content || content;
          }
        } catch (e) {
          // If parsing fails, use the content as is
        }
        return `[${new Date(msg.timestamp).toLocaleTimeString()}] ${content}`;
      }).join('\n');

      // Calculate basic stats
      const wordCount = messageTexts.split(/\s+/).length;
      const messageCount = messages.length;

      // Generate comprehensive analysis using OpenAI
      const response = await this.openai.chat.completions.create({
        model: "gpt-4",
        messages: [{
          role: "system",
          content: "You are an AI assistant analyzing WhatsApp conversations. Provide detailed analysis focusing on patterns, sentiment, and insights."
        }, {
          role: "user",
          content: `Analyze these recent messages and provide a detailed report with:
          1. Sentiment analysis (positive/negative/neutral with percentages)
          2. Top keywords or phrases (with frequency)
          3. Overall conversation tone
          4. Suggested priority level (HIGH/MEDIUM/LOW) based on content urgency and importance
          5. Topic categorization
          6. Communication patterns

          Format the response as a JSON object with these exact fields.

          Messages:
          ${messageTexts}`
        }],
        temperature: 0.7,
        max_tokens: 1000,
        response_format: { type: "json_object" }
      });

      const analysis = JSON.parse(response.choices[0].message.content);

      // Combine AI analysis with basic stats
      const fullAnalysis = {
        ...analysis,
        stats: {
          wordCount,
          messageCount,
          timespan: {
            start: messages[0].timestamp,
            end: messages[messages.length - 1].timestamp
          }
        }
      };

      // Store the analysis in the database
      const { error: insertError } = await adminClient
        .from('message_summaries')
        .upsert({
          user_id: userId,
          contact_id: parseInt(contactId),
          date: new Date().toISOString().split('T')[0],
          summary: analysis.summary || null,
          sentiment: analysis.sentiment,
          priority: analysis.suggestedPriority.toUpperCase(),
          keywords: analysis.keywords,
          message_count: messageCount,
          is_ai_suggested: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'contact_id,date'
        });

      // Update the contact's priority only if it's NULL or was AI-suggested before
      const shouldUpdatePriority = !contact.priority || 
        (contact.priority && !contact.last_analysis_at) || 
        (contact.last_analysis_at && new Date(contact.last_analysis_at) < new Date(Date.now() - 24 * 60 * 60 * 1000));

      if (shouldUpdatePriority) {
        const { error: updateError } = await adminClient
          .from('whatsapp_contacts')
          .update({ 
            last_analysis_at: new Date().toISOString(),
            priority: analysis.suggestedPriority.toUpperCase()
          })
          .eq('id', parseInt(contactId))
          .eq('user_id', userId);

        if (updateError) throw updateError;
      }

      if (insertError) throw insertError;

      console.info('Generated conversation analysis', { 
        userId, 
        contactId, 
        messageCount,
        updatedPriority: shouldUpdatePriority 
      });
      return fullAnalysis;

    } catch (error) {
      console.error('Error generating conversation analysis', { error, userId, contactId });
      throw error;
    }
  }

  async generateHistoricalSummary(userId, contactId, date) {
    try {
      // Get messages for the specified date
      const { data: messages, error: messagesError } = await adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .gte('timestamp', new Date(date).toISOString().split('T')[0])
        .lt(new Date(date.getTime() + 86400000).toISOString().split('T')[0])
        .order('timestamp', { ascending: true });

      if (messagesError) throw messagesError;

      if (!messages?.length) {
        console.info('No messages found for historical summary', { userId, contactId, date });
        return null;
      }

      const messageTexts = messages.map(msg => {
        let content = msg.content;
        try {
          if (typeof content === 'string' && content.startsWith('{')) {
            const parsed = JSON.parse(content);
            content = parsed.body || parsed.content || content;
          }
        } catch (e) {
          // If parsing fails, use the content as is
        }
        return `[${new Date(msg.timestamp).toLocaleTimeString()}] ${content}`;
      }).join('\n');

      // Generate basic summary for historical data
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{
          role: "system",
          content: "You are a helpful assistant that summarizes WhatsApp conversations. Provide a concise summary of the key points and any action items."
        }, {
          role: "user",
          content: `Please provide a brief summary of these messages with:
          1. Key points discussed
          2. Any action items or decisions made

          Messages:
          ${messageTexts}`
        }],
        temperature: 0.7,
        max_tokens: 500
      });

      const summary = response.choices[0].message.content;

      // Store the summary
      const { error: insertError } = await adminClient
        .from('message_summaries')
        .upsert({
          user_id: userId,
          contact_id: parseInt(contactId),
          date: date.toISOString().split('T')[0],
          summary,
          message_count: messages.length,
          is_ai_suggested: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'contact_id,date'
        });

      if (insertError) throw insertError;

      console.info('Generated historical summary', { userId, contactId, date, messageCount: messages.length });
      return summary;

    } catch (error) {
      console.error('Error generating historical summary', { error, userId, contactId, date });
      throw error;
    }
  }

  async getLatestSuggestedPriority(userId, contactId) {
    try {
      // Get the most recent priority suggestion from message_summaries
      const { data: latestSummary, error } = await adminClient
        .from('message_summaries')
        .select('priority, created_at')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error;

      return latestSummary?.priority || null;
    } catch (error) {
      console.error('Error getting latest suggested priority', { error, userId, contactId });
      throw error;
    }
  }

  // New method to initialize analysis for contacts without priority
  async initializeContactAnalysis(userId, contactId, force = false) {
    try {
      // Check if contact needs initialization
      const { data: contact, error: contactError } = await adminClient
        .from('whatsapp_contacts')
        .select('priority, last_analysis_at')
        .eq('user_id', userId)
        .eq('id', parseInt(contactId))
        .single();

      if (contactError) throw contactError;

      // If contact already has priority and analysis and force is false, skip
      if (!force && contact.priority && contact.last_analysis_at) {
        return { 
          priority: contact.priority,
          lastAnalysis: contact.last_analysis_at,
          wasInitialized: false
        };
      }

      // Get analysis to set initial priority
      const analysis = await this.getConversationAnalysis(userId, contactId);
      
      return {
        priority: analysis?.suggestedPriority || 'MEDIUM', // Default to MEDIUM if analysis fails
        lastAnalysis: new Date().toISOString(),
        wasInitialized: true
      };

    } catch (error) {
      console.error('Error initializing contact analysis', { error, userId, contactId });
      // Set default values if initialization fails
      const { error: updateError } = await adminClient
        .from('whatsapp_contacts')
        .update({ 
          priority: 'MEDIUM',
          last_analysis_at: new Date().toISOString()
        })
        .eq('id', parseInt(contactId))
        .eq('user_id', userId);

      return {
        priority: 'MEDIUM',
        lastAnalysis: new Date().toISOString(),
        wasInitialized: true,
        hadError: true
      };
    }
  }
}

export const aiAnalysisService = new AIAnalysisService(); 