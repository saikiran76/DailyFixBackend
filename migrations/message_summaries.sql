-- Create enum for priority levels
CREATE TYPE priority_level AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- Create message_summaries table
CREATE TABLE IF NOT EXISTS message_summaries (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    summary TEXT,
    sentiment JSONB,  -- Store sentiment analysis results
    priority priority_level,
    keywords JSONB,   -- Store extracted keywords with frequencies
    message_count INTEGER NOT NULL,
    is_ai_suggested BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Composite unique constraint to prevent duplicate summaries
    UNIQUE(contact_id, date)
);

-- Create indexes for faster lookups
CREATE INDEX idx_message_summaries_user_id ON message_summaries(user_id);
CREATE INDEX idx_message_summaries_contact_id ON message_summaries(contact_id);
CREATE INDEX idx_message_summaries_date ON message_summaries(date);
CREATE INDEX idx_message_summaries_priority ON message_summaries(priority);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_message_summaries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_message_summaries_timestamp
    BEFORE UPDATE ON message_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_message_summaries_updated_at();

-- Add RLS policies
ALTER TABLE message_summaries ENABLE ROW LEVEL SECURITY;

-- Policy to allow users to see only their own summaries
CREATE POLICY "Users can view their own summaries"
    ON message_summaries
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy to allow users to insert their own summaries
CREATE POLICY "Users can insert their own summaries"
    ON message_summaries
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy to allow users to update their own summaries
CREATE POLICY "Users can update their own summaries"
    ON message_summaries
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Add priority column to whatsapp_contacts if not exists
ALTER TABLE whatsapp_contacts
ADD COLUMN IF NOT EXISTS priority priority_level,
ADD COLUMN IF NOT EXISTS last_analysis_at TIMESTAMP WITH TIME ZONE; 