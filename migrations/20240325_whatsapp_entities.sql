-- Enable RLS
ALTER TABLE public.whatsapp_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_sync_requests ENABLE ROW LEVEL SECURITY;

-- Create contacts table
CREATE TABLE IF NOT EXISTS public.whatsapp_contacts (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) NOT NULL,
    whatsapp_id TEXT NOT NULL,
    display_name TEXT,
    profile_photo_url TEXT,
    sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'approved', 'rejected')),
    is_group BOOLEAN DEFAULT false,
    last_message_at TIMESTAMPTZ,
    unread_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, whatsapp_id)
);

-- Create messages table
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) NOT NULL,
    contact_id INTEGER REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    content TEXT,
    sender_id TEXT,
    sender_name TEXT,
    message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document')),
    metadata JSONB DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, message_id)
);

-- Create sync requests table
CREATE TABLE IF NOT EXISTS public.whatsapp_sync_requests (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) NOT NULL,
    contact_id INTEGER REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb,
    UNIQUE(user_id, contact_id)
);

-- Create indexes for better query performance
CREATE INDEX idx_whatsapp_contacts_user_id ON public.whatsapp_contacts(user_id);
CREATE INDEX idx_whatsapp_contacts_sync_status ON public.whatsapp_contacts(sync_status);
CREATE INDEX idx_whatsapp_messages_user_contact ON public.whatsapp_messages(user_id, contact_id);
CREATE INDEX idx_whatsapp_messages_timestamp ON public.whatsapp_messages(timestamp DESC);
CREATE INDEX idx_whatsapp_sync_requests_user_status ON public.whatsapp_sync_requests(user_id, status);

-- Create RLS policies
CREATE POLICY "Users can view their own contacts"
    ON public.whatsapp_contacts
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own messages"
    ON public.whatsapp_messages
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own sync requests"
    ON public.whatsapp_sync_requests
    FOR SELECT
    USING (auth.uid() = user_id);

-- Create function to update contact's updated_at
CREATE OR REPLACE FUNCTION public.update_whatsapp_contact_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER update_whatsapp_contact_timestamp
    BEFORE UPDATE ON public.whatsapp_contacts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_whatsapp_contact_timestamp(); 