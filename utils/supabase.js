import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Supabase clients
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Create necessary tables if they don't exist
export const createTables = async () => {
  try {
    console.log('Initializing database tables...');

    // First, check if tables exist
    const { data: userOnboardingExists } = await adminClient
      .from('user_onboarding')
      .select('id')
      .limit(1)
      .maybeSingle();

    const { data: accountsExists } = await adminClient
      .from('accounts')
      .select('id')
      .limit(1)
      .maybeSingle();

    // If tables don't exist, create them using raw SQL through Supabase's REST API
    if (userOnboardingExists === null) {
      console.log('Creating user_onboarding table...');
      
      // Create the table using adminClient
      const { error: createTableError } = await adminClient.rpc('create_table_if_not_exists', {
        table_name: 'user_onboarding',
        definition: `
          id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
          user_id UUID REFERENCES auth.users NOT NULL,
          current_step TEXT NOT NULL,
          is_complete BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id)
        `
      });

      if (createTableError) {
        console.error('Error creating user_onboarding table:', createTableError);
        throw createTableError;
      }

      console.log('Created user_onboarding table successfully');
    }

    if (accountsExists === null) {
      console.log('Creating accounts table...');
      
      // Create the table using adminClient
      const { error: createTableError } = await adminClient.rpc('create_table_if_not_exists', {
        table_name: 'accounts',
        definition: `
          id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
          user_id UUID REFERENCES auth.users NOT NULL,
          platform TEXT NOT NULL,
          credentials JSONB,
          status TEXT NOT NULL DEFAULT 'inactive',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, platform)
        `
      });

      if (createTableError) {
        console.error('Error creating accounts table:', createTableError);
        throw createTableError;
      }

      console.log('Created accounts table successfully');
    }

    console.log('Database initialization completed successfully');
    return true;
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
};

// Helper function to set auth context
export const setAuthContext = async (token) => {
  if (!token) {
    console.log('No token provided to setAuthContext');
    return null;
  }
  
  try {
    const { data: { user }, error: verifyError } = await supabase.auth.getUser(token);
    
    if (verifyError || !user) {
      console.error('Token verification failed:', verifyError);
      throw verifyError;
    }

    return user;
  } catch (error) {
    console.error('Error in setAuthContext:', error);
    throw error;
  }
};

export default adminClient; 

// import { supabase } from '../utils/supabase.js';

// export default async function authMiddleware(req, res, next) {
//   try {
//     const authHeader = req.headers.authorization;
//     if (!authHeader) {
//       return res.status(401).json({ error: 'No authorization header' });
//     }

//     const token = authHeader.replace('Bearer ', '');
    
//     // Set the auth context for Supabase client
//     const { data: { user }, error } = await supabase.auth.getUser(token);
    
//     if (error || !user) {
//       return res.status(401).json({ error: 'Invalid token' });
//     }

//     // Attach user to request
//     req.user = user;
    
//     // Set auth context for subsequent Supabase operations
//     await supabase.auth.setSession({
//       access_token: token,
//       refresh_token: ''
//     });

//     next();
//   } catch (error) {
//     console.error('Auth middleware error:', error);
//     res.status(401).json({ error: 'Authentication failed' });
//   }
// }