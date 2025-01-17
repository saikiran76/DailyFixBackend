import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export const generateChannelReport = async (messages, channelName) => {
  try {
    if (!messages || messages.length === 0) {
      throw new Error('No messages provided for report generation');
    }

    // Prepare messages for analysis
    const messageContent = messages.map(msg => ({
      author: msg.author.username,
      content: msg.content,
      timestamp: new Date(msg.timestamp).toLocaleTimeString()
    }));

    // Create system prompt
    const systemPrompt = `You are an AI assistant analyzing Discord channel activity. 
    Generate a comprehensive but concise report for the channel "${channelName}" based on today's messages. 
    Focus on key discussions, patterns, and notable interactions.`;

    // Create user prompt with message data
    const userPrompt = `Here are today's messages from the channel:
    ${JSON.stringify(messageContent, null, 2)}
    
    Please provide a report that includes:
    1. A brief summary of the main topics and discussions
    2. Notable patterns or trends in the conversation
    3. Key highlights or important moments
    4. Activity metrics (active participants, peak times)
    
    Format the response as a JSON object with the following structure:
    {
      "summary": "Overall summary of channel activity",
      "mainTopics": ["List of main topics discussed"],
      "keyHighlights": ["List of important moments or discussions"],
      "activityMetrics": {
        "activeParticipants": ["List of most active participants"],
        "peakTimes": ["List of peak activity times"],
        "messagePatterns": "Description of message patterns"
      }
    }`;

    // Get AI response
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1000,
      response_format: { type: "json_object" }
    });

    // Parse the AI response
    const reportData = JSON.parse(response.choices[0].message.content);

    // Add additional metrics
    reportData.messageCount = messages.length;
    reportData.uniqueUsers = new Set(messages.map(m => m.author.id)).size;
    reportData.timespan = {
      start: new Date(messages[0].timestamp).toISOString(),
      end: new Date(messages[messages.length - 1].timestamp).toISOString()
    };

    return reportData;
  } catch (error) {
    console.error('Error generating AI report:', error);
    throw new Error('Failed to generate AI report: ' + error.message);
  }
};

// Fallback report generation if AI service fails
export const generateBasicReport = (messages) => {
  try {
    const uniqueUsers = new Set(messages.map(m => m.author.id));
    const userActivity = {};
    messages.forEach(msg => {
      userActivity[msg.author.username] = (userActivity[msg.author.username] || 0) + 1;
    });

    return {
      summary: "Basic activity report generated",
      messageCount: messages.length,
      uniqueUsers: uniqueUsers.size,
      activityMetrics: {
        activeParticipants: Object.entries(userActivity)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 5)
          .map(([user]) => user),
        messagePatterns: "Basic statistics only"
      },
      timespan: {
        start: new Date(messages[0].timestamp).toISOString(),
        end: new Date(messages[messages.length - 1].timestamp).toISOString()
      }
    };
  } catch (error) {
    console.error('Error generating basic report:', error);
    throw new Error('Failed to generate basic report');
  }
};
