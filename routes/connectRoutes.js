// backend/routes/connectRoutes.js
import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { connectionManager } from '../services/directServices/connectionManager.js';
import { matrixWhatsAppService}  from '../services/matrixWhatsAppService.js';

const router = express.Router();

// Apply authentication middleware
router.use(authMiddleware);

// Initialize platform connection
router.post('/:platform/initialize', async (req, res) => {
  try {
    const { platform } = req.params;
    const { credentials } = req.body;
    const userId = req.user.id;

    const result = await connectionManager.initializeConnection(userId, platform, credentials);
    res.json(result);
  } catch (error) {
    console.error('Connection initialization error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Check connection status
router.get('/:platform/status', async (req, res) => {
  try {
    const { platform } = req.params;
    const userId = req.user.id;

    const result = await connectionManager.checkConnection(userId, platform);
    res.json({
      status: 'success',
      connected: result
    });
  } catch (error) {
    console.error('Connection status check error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Disconnect platform
router.post('/:platform/disconnect', async (req, res) => {
  try {
    const { platform } = req.params;
    const userId = req.user.id;

    const result = await connectionManager.disconnectPlatform(userId, platform);
    res.json(result);
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// WhatsApp-specific routes
router.post('/whatsapp/connect', async (req, res) => {
  try {
    const userId = req.user.id;
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

router.get('/whatsapp/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const isValid = await matrixWhatsAppService.validateMatrixClient(userId);
    res.json({
      status: 'success',
      connected: isValid
    });
  } catch (error) {
    console.error('WhatsApp status check error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

export default router;
