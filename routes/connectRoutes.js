// backend/routes/connectRoutes.js
import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { adminClient } from '../utils/supabase.js';
import { 
  initializePlatform, 
  finalizePlatform,
  handlePlatformError,
  checkPlatformStatus,
  disconnectPlatform
} from '../services/platformService.js';
import { 
  initializeDiscord,
  finalizeDiscord,
  getDiscordStatus,
  disconnectDiscord,
  getDiscordServers,
  getDiscordChannels,
  getDiscordDirectMessages,
  getDiscordMessages
} from '../services/directServices/discordDirect.js';
import {
  initializePlatform as initializeConnection,
  checkPlatformStatus as checkConnectionStatus,
  disconnectPlatform as disconnectConnection
} from '../services/directServices/connectionManager.js';
import reportService from '../services/reportService.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateUser);

// Discord OAuth2 Routes - Must come BEFORE generic platform routes
router.post('/discord/initiate', async (req, res) => {
  try {
    const userId = req.user.id;
    const { state } = req.body;
    
    // Debug session information
    console.log('Session debug:', {
      hasSession: !!req.session,
      sessionId: req.session?.id,
      userId,
      state,
      timestamp: new Date().toISOString()
    });
    
    if (!state) {
      console.error('Missing state parameter:', {
        userId,
        sessionId: req.session?.id || 'no-session'
      });
      return res.status(400).json({
        status: 'error',
        message: 'Missing state parameter'
      });
    }

    // Store state in session
    if (!req.session) {
      console.error('No session available:', {
        userId,
        state,
        headers: req.headers,
        timestamp: new Date().toISOString()
      });
      return res.status(500).json({
        status: 'error',
        message: 'Session initialization failed'
      });
    }

    const existingState = req.session.discordState;
    console.log('Storing OAuth state:', {
      userId,
      state,
      existingState,
      sessionId: req.session.id
    });

    req.session.discordState = state;
    
    // Force session save and wait for it
    await new Promise((resolve, reject) => {
      req.session.save(err => {
        if (err) {
          console.error('Session save error:', {
            error: err,
            userId,
            state,
            sessionId: req.session.id
          });
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Verify state was stored
    const verifyState = req.session.discordState;
    console.log('Verifying stored state:', {
      userId,
      state,
      verifyState,
      matches: state === verifyState,
      sessionId: req.session.id
    });

    if (!verifyState || verifyState !== state) {
      console.error('Failed to store state:', {
        userId,
        state,
        verifyState,
        sessionId: req.session.id
      });
      return res.status(500).json({
        status: 'error',
        message: 'Failed to securely store OAuth state'
      });
    }

    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds messages.read',
      state: state
    });

    const authUrl = `https://discord.com/api/oauth2/authorize?${params}`;
    
    console.log('Generated Discord OAuth URL:', {
      userId,
      state,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      sessionId: req.session.id
    });

    res.json({ url: authUrl });
  } catch (error) {
    console.error('Error initiating Discord connection:', {
      error,
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
      sessionId: req.session?.id,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to initiate Discord connection: ' + error.message
    });
  }
});

// Generic platform routes - Come AFTER specific platform routes
router.post('/:platform/initiate', async (req, res) => {
  const { platform } = req.params;
  const userId = req.user.id;

  try {
    console.log(`Initiating ${platform} connection for user:`, userId);
    
    // Validate platform - exclude Matrix and Discord (Discord uses OAuth)
    if (!['telegram', 'whatsapp'].includes(platform)) {
      return res.status(400).json({
        status: 'error',
        message: platform === 'matrix' ? 
          'Matrix is only available through protocol selection' : 
          `Unsupported platform: ${platform}`
      });
    }

    const result = await initializePlatform(userId, platform);
    return res.json(result);
  } catch (error) {
    console.error(`Error initializing ${platform}:`, error);
    return handlePlatformError(error, res);
  }
});

router.post('/:platform/finalize', authenticateUser, async (req, res) => {
  const { platform } = req.params;
  const { token } = req.body;
  const userId = req.user.id;

  try {
    console.log(`Finalizing ${platform} connection for user:`, userId);
    
    // Validate platform
    if (!['telegram', 'discord', 'whatsapp'].includes(platform)) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported platform: ${platform}`
      });
    }

    // Discord uses OAuth2 flow
    if (platform === 'discord') {
      return res.status(400).json({
        status: 'error',
        message: 'Discord uses OAuth2 flow. Please use the OAuth2 callback route.'
      });
    }

    if (!token) {
      return res.status(400).json({
        status: 'error',
        message: 'Token is required'
      });
    }

    const result = await finalizePlatform(userId, platform, token);
    console.log(`${platform} finalization result:`, result);

    // Update onboarding status
    const { data: accounts } = await adminClient
      .from('accounts')
      .select('platform')
      .eq('user_id', userId)
      .eq('status', 'connected');

    const connectedPlatforms = accounts?.map(acc => acc.platform) || [];
    
    await adminClient
      .from('user_onboarding')
      .upsert({
        user_id: userId,
        current_step: connectedPlatforms.length > 0 ? 'complete' : 'welcome',
        is_complete: connectedPlatforms.length > 0,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    return res.json(result);
  } catch (error) {
    console.error(`Error finalizing ${platform}:`, error);
    return handlePlatformError(error, res);
  }
});

router.get('/:platform/status', async (req, res) => {
  const { platform } = req.params;
  const userId = req.user.id;

  try {
    let status;
    
    if (platform === 'discord') {
      status = await getDiscordStatus(userId);
    } else {
      status = await checkPlatformStatus(userId, platform);
    }

    res.json(status);
  } catch (error) {
    console.error(`Error checking ${platform} status:`, error);
    return handlePlatformError(error, res);
  }
});

router.post('/:platform/disconnect', async (req, res) => {
  const { platform } = req.params;
  const userId = req.user.id;

  try {
    let result;
    
    if (platform === 'discord') {
      result = await disconnectDiscord(userId);
    } else {
      result = await disconnectPlatform(userId, platform);
    }

    res.json(result);
  } catch (error) {
    console.error(`Error disconnecting ${platform}:`, error);
    return handlePlatformError(error, res);
  }
});

// Keep existing Matrix routes for future use
router.post('/matrix/finalize', async (req, res) => {
  res.status(400).json({
    status: 'error',
    message: 'Matrix integration is only available through protocol selection. Please use direct API connection for other platforms.'
  });
});

// Discord OAuth2 configuration
const DISCORD_API_URL = 'https://discord.com/api/v10';

// Validate required environment variables
const requiredEnvVars = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI
} = process.env;

router.post('/discord/callback', authenticateUser, async (req, res) => {
  const { code, state } = req.body;
  const userId = req.user.id;

  try {
    console.log('Processing Discord OAuth callback:', {
      userId,
      hasCode: !!code,
      hasState: !!state,
      storedState: req.session.discordState,
      sessionId: req.session.id,
      timestamp: new Date().toISOString()
    });
    
    if (!code || !state) {
      console.error('Missing OAuth parameters:', {
        hasCode: !!code,
        hasState: !!state,
        userId
      });
      return res.status(400).json({
        status: 'error',
        message: 'Missing required OAuth parameters'
      });
    }

    // Verify state matches stored state
    const storedState = req.session.discordState;
    console.log('Validating OAuth state:', {
      receivedState: state,
      storedState,
      matches: state === storedState,
      userId,
      sessionId: req.session.id
    });

    if (!storedState) {
      console.error('No stored state found:', {
        receivedState: state,
        userId,
        sessionId: req.session.id
      });
      return res.status(400).json({
        status: 'error',
        message: 'No stored OAuth state found'
      });
    }

    if (state !== storedState) {
      console.error('State mismatch:', {
        receivedState: state,
        storedState,
        userId,
        sessionId: req.session.id
      });
      return res.status(400).json({
        status: 'error',
        message: 'Invalid OAuth state'
      });
    }

    // Clear stored state
    delete req.session.discordState;
    await req.session.save();
    console.log('Cleared stored OAuth state');

    // Initialize the connection
    console.log('Initializing Discord connection:', {
      userId,
      timestamp: new Date().toISOString()
    });

    const result = await initializeConnection(userId, 'discord', { code });
    
    console.log('Discord connection successful:', {
      userId,
      platform_username: result.platform_username,
      timestamp: new Date().toISOString()
    });

    // Return success response with connection details
    return res.json({
      status: 'active',
      platform_username: result.platform_username,
      global_name: result.global_name
    });
  } catch (error) {
    console.error('Error processing Discord callback:', {
      error,
      userId,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    return handlePlatformError(error, res);
  }
});

router.get('/discord/status', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Checking Discord status for user:', userId);
    
    // Validate user has active Discord connection
    const { data: account, error: accountError } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();
      
    if (accountError) {
      console.error('Error fetching Discord account:', accountError);
      return res.status(500).json({ 
        status: 'ERROR',
        message: 'Failed to verify Discord connection'
      });
    }
    
    if (!account || account.status !== 'active' || !account.credentials?.access_token) {
      return res.json({ 
        status: 'inactive',
        message: 'Discord connection not found or inactive'
      });
    }
    
    // Verify Discord connection is still valid
    try {
      const discordStatus = await getDiscordStatus(userId);
      return res.json({
        status: discordStatus.status,
        ...discordStatus
      });
    } catch (error) {
      console.error('Error verifying Discord connection:', error);
      return res.json({ 
        status: 'inactive',
        message: 'Discord connection validation failed'
      });
    }
  } catch (error) {
    console.error('Error checking Discord status:', error);
    return res.status(500).json({ 
      status: 'ERROR',
      message: 'Failed to check Discord status'
    });
  }
});

router.post('/discord/disconnect', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await disconnectDiscord(userId);
    res.json(result);
  } catch (error) {
    console.error('Error disconnecting Discord:', error);
    res.status(500).json({ message: 'Failed to disconnect Discord' });
  }
});

// Discord entity routes
router.get('/discord/servers', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Fetching Discord servers for user:', userId);
    
    // Validate user has active Discord connection
    const { data: account, error: accountError } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();
      
    if (accountError || !account) {
      return res.status(403).json({
        message: 'Discord account not found. Please connect your Discord account.'
      });
    }
    
    if (account.status !== 'active') {
      return res.status(403).json({
        message: 'Discord account is not active. Please reconnect your Discord account.'
      });
    }

    const servers = await getDiscordServers(userId);
    
    // Validate servers response
    if (!servers || !servers.data) {
      return res.status(500).json({ 
        message: 'Invalid response from Discord API'
      });
    }

    res.json({
      status: 'success',
      data: servers.data,
      meta: servers.meta
    });
  } catch (error) {
    console.error('Error fetching Discord servers:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        message: 'Discord authentication expired. Please reconnect your account.'
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to fetch Discord servers',
      details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
    });
  }
});

router.get('/discord/servers/:serverId/channels', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { serverId } = req.params;
    
    // Validate user has active Discord connection
    const { data: account, error: accountError } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();
      
    if (accountError || !account) {
      return res.status(403).json({
        message: 'Discord account not found. Please connect your Discord account.'
      });
    }
    
    if (account.status !== 'active') {
      return res.status(403).json({
        message: 'Discord account is not active. Please reconnect your Discord account.'
      });
    }

    const channels = await getDiscordChannels(userId, serverId);
    
    // Validate channels response
    if (!channels || !Array.isArray(channels)) {
      return res.status(500).json({ 
        message: 'Invalid response from Discord API'
      });
    }
    
    // Filter and validate channel objects
    const validatedChannels = channels
      .filter(channel => channel && channel.id)
      .map(channel => ({
        id: channel.id,
        name: channel.name || 'Unnamed Channel',
        type: channel.type,
        topic: channel.topic || null,
        position: channel.position || 0,
        parent_id: channel.parent_id || null,
        permission_overwrites: channel.permission_overwrites || [],
        nsfw: Boolean(channel.nsfw)
      }));
    
    res.json({
      status: 'success',
      data: validatedChannels,
      meta: {
        total: validatedChannels.length,
        hasMore: false
      }
    });
  } catch (error) {
    console.error('Error fetching Discord channels:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        message: 'Discord authentication expired. Please reconnect your account.'
      });
    }
    
    if (error.response?.status === 403) {
      return res.status(403).json({
        message: 'Insufficient permissions to access this server\'s channels.'
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to fetch Discord channels',
      details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
    });
  }
});

router.get('/discord/direct-messages', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Fetching Discord DMs for user:', userId);
    
    // Validate user has active Discord connection
    const { data: account, error: accountError } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();
      
    if (accountError || !account) {
      return res.status(403).json({
        status: 'error',
        message: 'Discord account not found. Please connect your Discord account.'
      });
    }
    
    if (account.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        message: 'Discord account is not active. Please reconnect your Discord account.'
      });
    }

    // Get DMs using the service
    const dms = await getDiscordDirectMessages(userId);
    
    // Return the response directly since it's already properly formatted
    return res.json(dms);

  } catch (error) {
    console.error('Error fetching Discord DMs:', error);
    
    // Handle specific error cases
    if (error.message?.includes('Discord client not ready')) {
      return res.status(503).json({
        status: 'error',
        message: 'Discord service is initializing. Please try again in a few moments.'
      });
    }
    
    if (error.message?.includes('Token validation failed')) {
      return res.status(401).json({
        status: 'error',
        message: 'Discord authentication expired. Please reconnect your account.'
      });
    }
    
    // Return generic error for other cases
    return res.status(500).json({ 
      status: 'error',
      message: 'Failed to fetch Discord direct messages',
      details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
    });
  }
});

router.get('/discord/channels/:channelId/messages', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { channelId } = req.params;
    
    // Validate user has active Discord connection
    const { data: account, error: accountError } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();
      
    if (accountError || !account) {
      return res.status(403).json({
        message: 'Discord account not found. Please connect your Discord account.'
      });
    }
    
    if (account.status !== 'active') {
      return res.status(403).json({
        message: 'Discord account is not active. Please reconnect your Discord account.'
      });
    }

    const messages = await getDiscordMessages(userId, channelId);
    
    // Validate messages response
    if (!messages || !Array.isArray(messages)) {
      return res.status(500).json({ 
        message: 'Invalid response from Discord API'
      });
    }
    
    // Filter and validate message objects
    const validatedMessages = messages
      .filter(msg => msg && msg.id)
      .map(msg => ({
        id: msg.id,
        content: msg.content,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          global_name: msg.author.global_name,
          avatar: msg.author.avatar
        },
        timestamp: msg.timestamp,
        edited_timestamp: msg.edited_timestamp,
        attachments: msg.attachments || [],
        embeds: msg.embeds || []
      }));
    
    res.json(validatedMessages);
  } catch (error) {
    console.error('Error fetching Discord messages:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        message: 'Discord authentication expired. Please reconnect your account.'
      });
    }
    
    if (error.response?.status === 403) {
      return res.status(403).json({
        message: 'Insufficient permissions to access this channel\'s messages.'
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to fetch Discord messages',
      details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
    });
  }
});

// Add report-related routes
router.get('/discord/servers/:serverId', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { serverId } = req.params;
    
    // Validate user has active Discord connection
    const { data: account, error: accountError } = await adminClient
      .from('accounts')
      .select('status, credentials')
      .eq('user_id', userId)
      .eq('platform', 'discord')
      .single();
      
    if (accountError || !account) {
      return res.status(403).json({
        status: 'error',
        message: 'Discord account not found. Please connect your Discord account.'
      });
    }
    
    if (account.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        message: 'Discord account is not active. Please reconnect your Discord account.'
      });
    }

    // Get server details using Discord.js client
    const client = await getDiscordClient(userId);
    if (!client || !client.isReady()) {
      return res.status(500).json({
        status: 'error',
        message: 'Discord connection not ready. Please try again.'
      });
    }

    const guild = await client.guilds.fetch(serverId);
    if (!guild) {
      return res.status(404).json({
        status: 'error',
        message: 'Server not found'
      });
    }

    // Return with consistent response format
    return res.json({
      status: 'success',
      data: {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        approximate_member_count: guild.approximateMemberCount,
        description: guild.description,
        features: guild.features
      },
      meta: {
        hasMore: false
      }
    });
  } catch (error) {
    console.error('Error fetching Discord server:', error);
    
    if (error.code === 50001) {
      return res.status(403).json({
        status: 'error',
        message: 'Bot does not have access to this server. Please reinvite the bot with proper permissions.'
      });
    }
    
    return res.status(500).json({ 
      status: 'error',
      message: 'Failed to fetch server details',
      details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
    });
  }
});

router.post('/discord/servers/:serverId/report', authenticateUser, async (req, res) => {
  try {
    const { serverId } = req.params;
    const { channelIds } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      return res.status(400).json({ error: 'Channel IDs must be provided as an array' });
    }

    const pdfBuffer = await reportService.generateReport(userId, serverId, channelIds);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=discord-report-${serverId}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    handlePlatformError(error, res);
  }
});

router.get('/discord/servers/:serverId/report/:reportId', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { serverId, reportId } = req.params;
    const report = await reportService.getReport(userId, serverId, reportId);
    res.json(report);
  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ message: 'Failed to fetch report' });
  }
});

router.get('/discord/servers/:serverId/report/:reportId/download', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { serverId, reportId } = req.params;
    const pdfBuffer = await reportService.generateReportPDF(userId, serverId, reportId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=report-${reportId}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ message: 'Failed to download report' });
  }
});

// Add state verification route
router.post('/discord/verify-state', authenticateUser, async (req, res) => {
  const { state } = req.body;
  const userId = req.user.id;

  try {
    console.log('Verifying Discord OAuth state:', {
      userId,
      receivedState: state,
      storedState: req.session.discordState,
      sessionId: req.session.id,
      timestamp: new Date().toISOString()
    });

    if (!state) {
      console.error('Missing state parameter:', {
        userId,
        sessionId: req.session?.id || 'no-session'
      });
      return res.status(400).json({
        status: 'error',
        message: 'Missing state parameter'
      });
    }

    // Verify state matches stored state
    const storedState = req.session.discordState;
    console.log('Validating OAuth state:', {
      receivedState: state,
      storedState,
      matches: state === storedState,
      userId,
      sessionId: req.session.id
    });

    if (!storedState) {
      console.error('No stored state found:', {
        receivedState: state,
        userId,
        sessionId: req.session.id
      });
      return res.json({
        isValid: false,
        message: 'No stored OAuth state found'
      });
    }

    if (state !== storedState) {
      console.error('State mismatch:', {
        receivedState: state,
        storedState,
        userId,
        sessionId: req.session.id
      });
      return res.json({
        isValid: false,
        message: 'Invalid OAuth state'
      });
    }

    // State is valid
    return res.json({
      isValid: true,
      message: 'State verified successfully'
    });
  } catch (error) {
    console.error('Error verifying Discord state:', {
      error,
      userId,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ 
      status: 'error',
      message: 'Failed to verify Discord state: ' + error.message
    });
  }
});

export default router;
