// backend/routes/platformsRoutes.js
import express from 'express';
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const platforms = [
      {
        id: 'matrix',
        name: 'Matrix',
        icon: 'https://wikiwandv2-19431.kxcdn.com/_next/image?url=https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/Matrix_logo.svg/640px-Matrix_logo.svg.png&w=640&q=50',
        description: 'Open network for secure, decentralized communication',
        requiresLogin: true
      },
      {
        id: 'telegram',
        name: 'Telegram',
        icon: 'https://logodownload.org/wp-content/uploads/2017/11/telegram-logo-8.png',
        description: 'Cloud-based instant messaging',
        requiresToken: true
      },
      {
        id: 'whatsapp',
        name: 'WhatsApp',
        icon: 'https://www.imagensempng.com.br/wp-content/uploads/2020/12/logo-whatsapp-png_optimized-1024x1024.png',
        description: 'End-to-end encrypted messaging',
        requiresQR: true
      }
    ];
    
    res.json({ platforms });
  } catch (error) {
    console.error('Error fetching platforms:', error);
    res.status(500).json({ error: 'Failed to fetch platforms' });
  }
});

export default router;
