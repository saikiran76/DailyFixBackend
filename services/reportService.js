import PDFDocument from 'pdfkit';
import { getDiscordClient } from './directServices/discordDirect.js';
import OpenAI from 'openai';
import { adminClient } from '../utils/supabase.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

class ReportService {
  async generateReport(userId, serverId, channelIds) {
    try {
      const client = await getDiscordClient(userId);
      if (!client) {
        throw new Error('Discord client not found');
      }

      const server = await client.guilds.fetch(serverId);
      if (!server) {
        throw new Error('Server not found');
      }

      const channelData = [];
      for (const channelId of channelIds) {
        const channel = await server.channels.fetch(channelId);
        if (channel) {
          const messages = await channel.messages.fetch({ limit: 100 });
          const messageData = Array.from(messages.values()).map(msg => ({
            author: msg.author.username,
            content: msg.content,
            timestamp: msg.createdAt
          }));

          // Analyze messages using OpenAI
          const analysis = await this.analyzeMessages(messageData);
          
          channelData.push({
            name: channel.name,
            messages: messageData,
            analysis
          });
        }
      }

      // Generate overall summary using OpenAI
      const overallSummary = await this.generateOverallSummary(channelData);

      return this.generatePDF(server.name, channelData, overallSummary);
    } catch (error) {
      console.error('Error generating report:', error);
      throw error;
    }
  }

  async analyzeMessages(messages) {
    try {
      const messageContent = messages.map(msg => 
        `${msg.author}: ${msg.content}`
      ).join('\n');

      const prompt = `Analyze the following Discord conversation and provide:
1. A brief summary of the discussion
2. Key points and decisions made
3. Action items or next steps
4. Sentiment analysis of the conversation

Conversation:
${messageContent}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{
          role: "system",
          content: "You are an AI assistant analyzing Discord conversations to generate insightful reports."
        }, {
          role: "user",
          content: prompt
        }],
        temperature: 0.7,
        max_tokens: 1000
      });

      const analysis = response.choices[0].message.content;
      return this.parseAnalysis(analysis);
    } catch (error) {
      console.error('Error analyzing messages:', error);
      throw error;
    }
  }

  async generateOverallSummary(channelData) {
    try {
      const channelSummaries = channelData.map(channel => 
        `Channel: ${channel.name}\n${channel.analysis.summary}`
      ).join('\n\n');

      const prompt = `Generate an executive summary of the following Discord channel discussions:
${channelSummaries}

Please provide:
1. Overall summary of discussions across all channels
2. Common themes or patterns
3. High-level recommendations`;

      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{
          role: "system",
          content: "You are an AI assistant generating executive summaries of Discord conversations."
        }, {
          role: "user",
          content: prompt
        }],
        temperature: 0.7,
        max_tokens: 500
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error generating overall summary:', error);
      throw error;
    }
  }

  parseAnalysis(analysisText) {
    // Split the analysis into sections based on numbered points
    const sections = analysisText.split(/\d+\./g).filter(Boolean);
    return {
      summary: sections[0]?.trim() || '',
      keyPoints: sections[1]?.trim().split('\n').filter(Boolean) || [],
      actionItems: sections[2]?.trim().split('\n').filter(Boolean) || [],
      sentiment: sections[3]?.trim() || ''
    };
  }

  generatePDF(serverName, channelData, overallSummary) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument();
        const chunks = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(chunks);
          // Clean up resources
          chunks.length = 0;
          resolve(pdfBuffer);
        });
        doc.on('error', (error) => {
          // Clean up resources on error
          chunks.length = 0;
          reject(error);
        });

        // Title and Overall Summary
        doc.fontSize(24).text(`Discord Report: ${serverName}`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(18).text('Executive Summary');
        doc.fontSize(12).text(overallSummary);
        doc.moveDown(2);

        // Channel Analysis
        channelData.forEach(channel => {
          doc.fontSize(16).text(`Channel: ${channel.name}`);
          doc.moveDown();

          // Summary
          doc.fontSize(14).text('Summary');
          doc.fontSize(12).text(channel.analysis.summary);
          doc.moveDown();

          // Key Points
          doc.fontSize(14).text('Key Points');
          channel.analysis.keyPoints.forEach(point => {
            doc.fontSize(12).text(`• ${point}`);
          });
          doc.moveDown();

          // Action Items
          doc.fontSize(14).text('Action Items');
          channel.analysis.actionItems.forEach(item => {
            doc.fontSize(12).text(`• ${item}`);
          });
          doc.moveDown();

          // Sentiment
          doc.fontSize(14).text('Sentiment Analysis');
          doc.fontSize(12).text(channel.analysis.sentiment);
          doc.moveDown(2);

          doc.addPage();
        });

        doc.end();
      } catch (error) {
        // Clean up resources on error
        chunks.length = 0;
        reject(error);
      }
    });
  }

  async getReport(userId, serverId, reportId) {
    try {
      const { data: report, error } = await adminClient
        .from('discord_reports')
        .select('report_data')
        .eq('user_id', userId)
        .eq('server_id', serverId)
        .eq('report_id', reportId)
        .single();

      if (error) throw error;
      if (!report) throw new Error('Report not found');

      return report.report_data;
    } catch (error) {
      console.error(`Error fetching report for ${userId}:`, error);
      throw error;
    }
  }

  async generateReportPDF(userId, serverId, reportId) {
    try {
      const report = await this.getReport(userId, serverId, reportId);
      const client = await getDiscordClient(userId);
      if (!client) {
        throw new Error('Discord client not found');
      }

      const server = await client.guilds.fetch(serverId);
      if (!server) {
        throw new Error('Server not found');
      }

      // Create PDF document
      const doc = new PDFDocument();
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {});

      // Add content to PDF
      doc.fontSize(24).text(server.name, { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).text(`Report generated on ${new Date(report.generatedAt).toLocaleString()}`);
      doc.moveDown();

      // Summary section
      doc.fontSize(18).text('Summary');
      doc.moveDown();
      doc.fontSize(12).text(report.summary);
      doc.moveDown();

      // Channel sections
      for (const channel of report.channels) {
        doc.fontSize(16).text(`#${channel.name}`);
        doc.moveDown();

        doc.fontSize(14).text('Key Points');
        doc.moveDown();
        channel.keyPoints.forEach(point => {
          doc.fontSize(12).text(`• ${point}`);
        });
        doc.moveDown();

        if (channel.actionItems.length > 0) {
          doc.fontSize(14).text('Action Items');
          doc.moveDown();
          channel.actionItems.forEach(item => {
            doc.fontSize(12).text(`• ${item}`);
          });
          doc.moveDown();
        }
      }

      doc.end();

      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`Error generating PDF for ${userId}:`, error);
      throw error;
    }
  }
}

export default new ReportService(); 