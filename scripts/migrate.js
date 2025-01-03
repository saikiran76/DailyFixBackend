import { adminClient } from '../utils/supabase.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  try {
    // Read migration file
    const migrationPath = path.join(__dirname, '..', 'migrations', '20240324_update_accounts.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf8');
    console.log('Migration SQL:', migrationSQL);

    // Execute migration using Supabase REST API
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/run_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        query: migrationSQL
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Migration error:', error);
      process.exit(1);
    }

    console.log('Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error running migration:', error);
    process.exit(1);
  }
}

runMigration(); 