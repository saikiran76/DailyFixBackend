import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function runMigrations() {
  try {
    // Read migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const migrations = [
      '20240324_update_accounts.sql',
      '20240324_store_discord_connection.sql'
    ];

    for (const migration of migrations) {
      console.log(`Running migration: ${migration}`);
      const migrationPath = path.join(migrationsDir, migration);
      const migrationSQL = await fs.readFile(migrationPath, 'utf8');

      // Execute migration
      const { error } = await supabase.rpc('run_sql', {
        query: migrationSQL
      });

      if (error) {
        console.error(`Error running migration ${migration}:`, error);
        process.exit(1);
      }

      console.log(`Successfully ran migration: ${migration}`);
    }

    console.log('All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error running migrations:', error);
    process.exit(1);
  }
}

runMigrations(); 