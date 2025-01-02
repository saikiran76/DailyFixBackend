-- Add new columns for platform data and credentials
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS platform_data JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS credentials JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS platform_user_id TEXT,
ADD COLUMN IF NOT EXISTS platform_username TEXT;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_accounts_platform_user_id ON accounts(platform_user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);

-- Add constraints
ALTER TABLE accounts
ADD CONSTRAINT unique_platform_user_per_platform UNIQUE (user_id, platform, platform_user_id);

-- Comment on columns
COMMENT ON COLUMN accounts.platform_data IS 'Platform-specific user data like avatar, display name, etc.';
COMMENT ON COLUMN accounts.credentials IS 'Encrypted credentials including tokens, refresh tokens, etc.';
COMMENT ON COLUMN accounts.platform_user_id IS 'User ID from the platform';
COMMENT ON COLUMN accounts.platform_username IS 'Username from the platform'; 