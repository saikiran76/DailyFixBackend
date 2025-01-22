import { createClient } from '@supabase/supabase-js';
import pkg from 'pg';
const { Pool } = pkg;
import logger from './logger.js';

// Constants for pool configuration
const POOL_CONFIG = {
  MIN_POOL_SIZE: 2,
  MAX_POOL_SIZE: 10,
  IDLE_TIMEOUT: 10000,
  CONNECTION_TIMEOUT: 3000,
  MAX_USES_PER_CONNECTION: 7500,
  QUEUE_TIMEOUT: 8000
};

class DatabaseService {
  constructor() {
    // Initialize Supabase clients
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    this.adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // Parse DATABASE_URL to get components
    const dbUrl = new URL(process.env.DATABASE_URL);
    
    // Initialize connection pool with explicit credentials
    this.pool = new Pool({
      user: dbUrl.username,
      password: process.env.POSTGRES_PASSWORD,
      host: dbUrl.hostname,
      port: parseInt(dbUrl.port),
      database: dbUrl.pathname.split('/')[1],
      ssl: {
        rejectUnauthorized: false // Required for Supabase's SSL connection
      },
      min: POOL_CONFIG.MIN_POOL_SIZE,
      max: POOL_CONFIG.MAX_POOL_SIZE,
      idleTimeoutMillis: POOL_CONFIG.IDLE_TIMEOUT,
      connectionTimeoutMillis: POOL_CONFIG.CONNECTION_TIMEOUT,
      maxUses: POOL_CONFIG.MAX_USES_PER_CONNECTION,
      queueTimeout: POOL_CONFIG.QUEUE_TIMEOUT
    });

    // Set up pool error handler
    this.pool.on('error', (err, client) => {
      logger.error('Unexpected error on idle client', err);
    });

    // Track active transactions
    this.activeTransactions = new Map();
  }

  async executeWithRetry(operation, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isRetryableError(error) || attempt === maxRetries) {
          throw error;
        }
        await this.delay(Math.min(100 * Math.pow(2, attempt), 1000));
      }
    }
    throw lastError;
  }

  isRetryableError(error) {
    const retryableCodes = [
      '40001', // serialization_failure
      '40P01', // deadlock_detected
      '55P03', // lock_not_available
      'XX000'  // internal_error
    ];
    return retryableCodes.includes(error.code);
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async query(text, params, options = {}) {
    const { useTransaction = false, retries = 3 } = options;

    if (useTransaction) {
      return this.withTransaction(async (client) => {
        return this.executeWithRetry(async () => {
          return client.query(text, params);
        }, retries);
      });
    }

    return this.executeWithRetry(async () => {
      const client = await this.pool.connect();
      try {
        return await client.query(text, params);
      } finally {
        client.release();
      }
    }, retries);
  }

  async batchQuery(queries) {
    return this.withTransaction(async (client) => {
      const results = [];
      for (const { text, params } of queries) {
        const result = await client.query(text, params);
        results.push(result);
      }
      return results;
    });
  }

  async healthCheck() {
    try {
      const result = await this.query('SELECT 1');
      return {
        healthy: result.rows[0]['?column?'] === 1,
        poolSize: this.pool.totalCount,
        waiting: this.pool.waitingCount,
        idle: this.pool.idleCount
      };
    } catch (error) {
      logger.error('Database health check failed:', error);
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  async initializeTables() {
    try {
      // First, clean up any redundant tables
      await this.query('DROP TABLE IF EXISTS onboarding CASCADE;');
      logger.info('Cleaned up redundant tables');

      // Check which tables need to be created
      const tableCheck = await this.query(`
        SELECT 
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') as users_exist,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts') as accounts_exist,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_contacts') as contacts_exist,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_messages') as messages_exist,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_sync_requests') as sync_requests_exist,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_onboarding') as user_onboarding_exist;
      `);

      const tables = tableCheck.rows[0];
      logger.info('Checking existing tables:', tables);

      // Create only missing tables
      if (!tables.users_exist) {
        await this.query(`
          CREATE TABLE users (
            id UUID PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        logger.info('Users table created');
      }

      if (!tables.accounts_exist) {
        await this.query(`
          CREATE TABLE accounts (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id),
            platform TEXT NOT NULL,
            credentials JSONB,
            status TEXT DEFAULT 'inactive',
            connected_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            platform_user_id TEXT,
            platform_username TEXT,
            platform_data JSONB DEFAULT '{}',
            refresh_token TEXT,
            webhook_id TEXT,
            webhook_token TEXT,
            last_message_id TEXT,
            channels_config JSONB DEFAULT '{}',
            last_token_refresh TIMESTAMPTZ,
            metadata JSONB DEFAULT '{}'
          );
        `);
        logger.info('Accounts table created');
      }

      if (!tables.contacts_exist) {
        await this.query(`
          CREATE TABLE whatsapp_contacts (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES users(id),
            whatsapp_id TEXT NOT NULL,
            display_name TEXT,
            profile_photo_url TEXT,
            sync_status TEXT DEFAULT 'pending',
            is_group BOOLEAN DEFAULT false,
            last_message_at TIMESTAMPTZ,
            unread_count INTEGER DEFAULT 0,
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            bridge_room_id TEXT,
            priority INTEGER,
            last_analysis_at TIMESTAMPTZ,
            UNIQUE(user_id, whatsapp_id)
          );
        `);
        logger.info('WhatsApp contacts table created');
      }

      if (!tables.messages_exist) {
        await this.query(`
          CREATE TABLE whatsapp_messages (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES users(id),
            contact_id INTEGER REFERENCES whatsapp_contacts(id),
            message_id TEXT NOT NULL,
            content TEXT,
            sender_id TEXT,
            sender_name TEXT,
            message_type TEXT DEFAULT 'text',
            metadata JSONB DEFAULT '{}',
            timestamp TIMESTAMPTZ NOT NULL,
            is_read BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(contact_id, message_id)
          );
        `);
        logger.info('WhatsApp messages table created');
      }

      if (!tables.sync_requests_exist) {
        await this.query(`
          CREATE TABLE whatsapp_sync_requests (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES users(id),
            contact_id INTEGER REFERENCES whatsapp_contacts(id),
            status TEXT DEFAULT 'pending',
            requested_at TIMESTAMPTZ DEFAULT NOW(),
            approved_at TIMESTAMPTZ,
            metadata JSONB DEFAULT '{}',
            UNIQUE(user_id, contact_id)
          );
        `);
        logger.info('WhatsApp sync requests table created');
      }

      if (!tables.user_onboarding_exist) {
        await this.query(`
          CREATE TABLE user_onboarding (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id) UNIQUE,
            current_step TEXT DEFAULT 'welcome',
            is_complete BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        logger.info('User onboarding table created');
      }

      // Verify indexes
      const indexCheck = await this.query(`
        SELECT indexname, tablename 
        FROM pg_indexes 
        WHERE schemaname = 'public' 
        AND indexname LIKE 'idx_%';
      `);
      
      const existingIndexes = new Set(indexCheck.rows.map(row => row.indexname));
      
      // Create only missing indexes
      const requiredIndexes = [
        { name: 'idx_accounts_user_id', table: 'accounts', columns: 'user_id' },
        { name: 'idx_accounts_platform', table: 'accounts', columns: 'platform' },
        { name: 'idx_whatsapp_contacts_user_id', table: 'whatsapp_contacts', columns: 'user_id' },
        { name: 'idx_whatsapp_messages_contact_id', table: 'whatsapp_messages', columns: 'contact_id' },
        { name: 'idx_whatsapp_messages_user_id', table: 'whatsapp_messages', columns: 'user_id' },
        { name: 'idx_whatsapp_sync_requests_user_id', table: 'whatsapp_sync_requests', columns: 'user_id' },
        { name: 'idx_whatsapp_sync_requests_contact_id', table: 'whatsapp_sync_requests', columns: 'contact_id' }
      ];

      for (const index of requiredIndexes) {
        if (!existingIndexes.has(index.name)) {
          await this.query(`CREATE INDEX ${index.name} ON ${index.table}(${index.columns});`);
          logger.info(`Created index ${index.name}`);
        }
      }

      // Create or update trigger function
      await this.query(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ language 'plpgsql';
      `);

      // Verify and create triggers
      const tables_with_timestamps = ['users', 'accounts', 'whatsapp_contacts', 'user_onboarding'];
      for (const table of tables_with_timestamps) {
        const triggerExists = await this.query(`
          SELECT 1 FROM pg_trigger 
          WHERE tgname = $1 
          AND tgrelid = $2::regclass;
        `, [`update_${table}_updated_at`, table]);

        if (!triggerExists.rows.length) {
          await this.query(`
            CREATE TRIGGER update_${table}_updated_at
              BEFORE UPDATE ON ${table}
              FOR EACH ROW
              EXECUTE FUNCTION update_updated_at_column();
          `);
          logger.info(`Created trigger for ${table}`);
        }
      }

      logger.info('Database initialization completed successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize tables:', error);
      throw error;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    try {
      await this.pool.end();
    } catch (error) {
      logger.error('Error during pool cleanup:', error);
    }
  }
}

// Export singleton instance
export const databaseService = new DatabaseService(); 