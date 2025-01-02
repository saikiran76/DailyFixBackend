import express from 'express';
import { adminClient } from '../utils/supabase.js';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

router.post('/migrate', async (req, res) => {
  try {
    // Read migration file
    const migrationPath = path.join(process.cwd(), 'migrations', '20240324_update_accounts.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf8');

    // Execute migration
    const { error } = await adminClient.rpc('run_migration', {
      sql: migrationSQL
    });

    if (error) {
      console.error('Migration error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Migration completed successfully' });
  } catch (error) {
    console.error('Error running migration:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;