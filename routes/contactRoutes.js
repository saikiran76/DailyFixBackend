import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { fetchAllContacts } from '../services/contactService.js';

const router = express.Router();
router.use(authenticateToken);

router.get('/', async (req, res) => {
    try {
      const contacts = await fetchAllContacts(req.user._id);
      res.json({ contacts });
    } catch (err) {
      console.error('Error fetching contacts:', err);
      res.status(500).json({ error: 'Failed to fetch contacts' });
    }
  });

export default router;
