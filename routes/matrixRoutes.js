import express from 'express';
import { matrixWhatsAppService } from '../services/matrixWhatsAppService.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { validateBridgeBot } from '../utils/matrixValidation.js';
import { adminClient } from '../utils/supabase.js';

const router = express.Router();

// Initialize Matrix client
router.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const { userId: matrixUserId, password, homeserver } = req.body;
    const systemUserId = req.user.id; // Get the authenticated user's UUID from authMiddleware
    const authToken = req.headers.authorization?.split(' ')[1]; // Get the JWT token

    if (!authToken) {
      return res.status(401).json({
        status: 'error',
        message: 'No authorization token provided'
      });
    }

    // Validate required fields
    if (!matrixUserId || !password || !homeserver) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: userId (Matrix), password, homeserver'
      });
    }

    console.log('Initializing Matrix client for user:', {
      systemUserId,
      matrixUserId
    });

    const result = await matrixWhatsAppService.initialize({
      userId: systemUserId, // Pass the system UUID
      credentials: {
        userId: matrixUserId, // Pass the Matrix user ID
        password,
        homeserver
      },
      authToken // Pass the auth token
    });

    console.log('Matrix initialization result:', {
      status: result.status,
      message: result.message
    });

    res.json(result);
  } catch (error) {
    console.error('Matrix initialization error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Connect WhatsApp
router.post('/whatsapp/connect', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;  // Get userId from authenticated request
    console.log('Connecting WhatsApp for user:', userId);

    const result = await matrixWhatsAppService.connectWhatsApp(userId);
    res.json(result);
  } catch (error) {
    console.error('WhatsApp connection error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Disconnect WhatsApp
router.post('/whatsapp/disconnect', authMiddleware, async (req, res) => {
  const { userId } = req.body;

  try {
    const result = await matrixWhatsAppService.disconnectWhatsApp(userId);
    res.json(result);
  } catch (error) {
    console.error('WhatsApp disconnect error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get WhatsApp connection status
router.get('/whatsapp/status', authMiddleware, async (req, res) => {
  const { userId } = req.query;

  try {
    const result = await matrixWhatsAppService.getStatus(userId);
    res.json(result);
  } catch (error) {
    console.error('WhatsApp status check error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Sync WhatsApp messages
router.post('/whatsapp/sync', authMiddleware, async (req, res) => {
  const { userId } = req.body;

  try {
    const result = await matrixWhatsAppService.syncMessages(userId);
    res.json(result);
  } catch (error) {
    console.error('WhatsApp message sync error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Add status check endpoints
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const isConnected = await matrixWhatsAppService.validateMatrixClient(userId);
    
    res.json({
      status: 'success',
      connected: isConnected
    });
  } catch (error) {
    console.error('Error checking Matrix status:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

router.get('/whatsapp/bridge/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Checking bridge status for user:', userId);

    const client = matrixWhatsAppService.getMatrixClient(userId);
    if (!client) {
      console.error('No Matrix client found for user:', userId);
      return res.status(400).json({
        status: 'error',
        message: 'Matrix client not initialized. Please connect to Matrix first.'
      });
    }

    console.log('Got Matrix client, validating bridge bot...');
    const bridgeStatus = await validateBridgeBot(client);
    console.log('Bridge validation result:', bridgeStatus);
    
    if (!bridgeStatus.valid) {
      return res.status(503).json({
        status: 'error',
        message: bridgeStatus.error || 'Bridge bot is not available',
        details: bridgeStatus
      });
    }

    res.json({
      status: 'success',
      online: true,
      details: bridgeStatus.status
    });
  } catch (error) {
    console.error('Error checking bridge status:', error);
    res.status(500).json({
      status: 'error',
      message: error.message,
      details: error.stack
    });
  }
});

// Add this route to handle media proxy
router.get('/media/proxy', authMiddleware, async (req, res) => {
  try {
    const { mxc_url } = req.query;
    if (!mxc_url) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing mxc_url parameter'
      });
    }

    // Get Matrix client for the user
    const userId = req.user.id;
    const matrixClient = matrixWhatsAppService.getMatrixClient(userId);
    if (!matrixClient) {
      return res.status(400).json({
        status: 'error',
        message: 'Matrix client not initialized'
      });
    }

    // Parse mxc URL
    const mxcMatch = mxc_url.match(/^mxc:\/\/([^/]+)\/([^/]+)$/);
    if (!mxcMatch) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid mxc URL format'
      });
    }

    const [, serverName, mediaId] = mxcMatch;
    console.log('Fetching media for:', { serverName, mediaId });

    // Use the thumbnail endpoint with specific dimensions for QR code
    const baseUrl = matrixClient.baseUrl;
    const accessToken = matrixClient.getAccessToken();
    const thumbnailUrl = `${baseUrl}/_matrix/media/v3/thumbnail/${serverName}/${mediaId}?width=400&height=400&method=scale`;
    
    console.log('Fetching thumbnail from:', thumbnailUrl);

    const response = await fetch(thumbnailUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch thumbnail: ${response.status} ${response.statusText}`);
    }

    // Get content type and other headers
    const contentType = response.headers.get('content-type') || 'image/png';
    const contentLength = response.headers.get('content-length');
    
    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Pipe the response
    response.body.pipe(res);
  } catch (error) {
    console.error('Media proxy error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Update WhatsApp connection status
router.post('/whatsapp/update-status', authMiddleware, async (req, res) => {
  try {
    const { status, bridgeRoomId } = req.body;
    const userId = req.user.id;

    console.log('Updating WhatsApp status:', {
      userId,
      status,
      bridgeRoomId
    });

    if (!status) {
      return res.status(400).json({
        status: 'error',
        message: 'Status is required'
      });
    }

    // Map the incoming status to the correct enum value
    const accountStatus = status === 'connected' ? 'active' : 'inactive';

    // First check if the account exists
    const { data: existingAccount, error: fetchError } = await adminClient
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'whatsapp')
      .maybeSingle();

    if (fetchError && !fetchError.message.includes('contains 0 rows')) {
      console.error('Error fetching existing account:', fetchError);
      throw fetchError;
    }

    const accountData = {
      user_id: userId,
      platform: 'whatsapp',
      status: accountStatus, // Use the mapped enum value
      credentials: {
        ...(existingAccount?.credentials || {}),
        bridge_room_id: bridgeRoomId
      },
      updated_at: new Date().toISOString()
    };

    if (!existingAccount) {
      accountData.created_at = accountData.updated_at;
    }

    console.log('Upserting account data:', accountData);

    // Update or insert the account
    const { data, error } = await adminClient
      .from('accounts')
      .upsert(accountData, {
        onConflict: 'user_id,platform',
        ignoreDuplicates: false
      });

    if (error) {
      console.error('Error upserting account:', error);
      throw error;
    }

    console.log('Successfully updated WhatsApp status');

    res.json({
      status: 'success',
      data: accountData
    });
  } catch (error) {
    console.error('Error updating WhatsApp status:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to update WhatsApp status',
      details: error.details || error.toString()
    });
  }
});

// Remove duplicate routes
router.get('/whatsapp/invites', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Getting pending invites for user:', userId);

    const pendingInvites = await matrixWhatsAppService.getPendingInvites(userId);
    
    res.json({
      status: 'success',
      data: pendingInvites
    });
  } catch (error) {
    console.error('Error getting pending invites:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to get pending invites'
    });
  }
});

// Single accept-invite route
router.post('/whatsapp/accept-invite', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user.id;

    console.log('Accepting room invitation:', {
      userId,
      roomId
    });

    if (!roomId) {
      return res.status(400).json({
        status: 'error',
        message: 'Room ID is required'
      });
    }

    const result = await matrixWhatsAppService.acceptRoomInvite(userId, roomId);
    res.json(result);
  } catch (error) {
    console.error('Error accepting room invitation:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to accept room invitation'
    });
  }
});

export default router; 