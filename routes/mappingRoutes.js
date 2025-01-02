import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { 
  createMatrixMapping, 
  getMatrixMappings, 
  deleteMatrixMapping 
} from '../services/matrixMappingService.js';
import { initializeBridge } from '../services/matrixBridgeService.js';

const router = express.Router();
router.use(authenticateToken);

// Create new channel mapping
router.post('/matrix', async (req, res) => {
  const userId = req.user?._id;
  const { sourceData, targetData } = req.body;

  try {
    const mapping = await createMatrixMapping(userId, sourceData, targetData);
    
    // Initialize or update bridge with new mapping
    await initializeBridge(userId, sourceData.platform);

    res.json({ 
      status: 'success',
      mapping 
    });
  } catch (error) {
    console.error('Mapping creation error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get mappings for a platform
router.get('/matrix/:platform', async (req, res) => {
  const userId = req.user?._id;
  const { platform } = req.params;

  try {
    const mappings = await getMatrixMappings(userId, platform);
    res.json({ mappings });
  } catch (error) {
    console.error('Error fetching mappings:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Delete mapping
router.delete('/matrix/:mappingId', async (req, res) => {
  const userId = req.user?._id;
  const { mappingId } = req.params;

  try {
    const result = await deleteMatrixMapping(userId, mappingId);
    if (!result) {
      return res.status(404).json({
        status: 'error',
        message: 'Mapping not found'
      });
    }
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Error deleting mapping:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

export default router; 