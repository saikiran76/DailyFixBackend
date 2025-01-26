-- Create stored procedure for atomic onboarding status updates
CREATE OR REPLACE FUNCTION public.update_onboarding_status(
    p_user_id UUID,
    p_current_step TEXT,
    p_previous_step TEXT,
    p_is_complete BOOLEAN,
    p_transaction_id TEXT,
    p_is_rollback BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    success BOOLEAN,
    message TEXT,
    current_step TEXT,
    is_complete BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_last_transaction TEXT;
    v_current_status RECORD;
BEGIN
    -- Start transaction
    BEGIN
        -- Check if this is a rollback of a previous transaction
        IF p_is_rollback THEN
            -- Verify we're rolling back to a valid previous state
            SELECT * INTO v_current_status
            FROM public.user_onboarding
            WHERE user_id = p_user_id
            FOR UPDATE;

            IF v_current_status.current_step = p_current_step THEN
                RETURN QUERY SELECT 
                    TRUE,
                    'No rollback needed - state unchanged',
                    v_current_status.current_step,
                    v_current_status.is_complete;
                RETURN;
            END IF;

            -- Execute rollback
            UPDATE public.user_onboarding
            SET 
                current_step = p_previous_step,
                is_complete = FALSE,
                updated_at = NOW()
            WHERE user_id = p_user_id
            RETURNING TRUE, 'Rollback successful', current_step, is_complete;

        ELSE
            -- This is a new transaction
            -- First, get current status with lock
            SELECT * INTO v_current_status
            FROM public.user_onboarding
            WHERE user_id = p_user_id
            FOR UPDATE;

            -- Validate transition
            IF v_current_status.is_complete AND NOT p_is_complete THEN
                RAISE EXCEPTION 'Cannot modify completed onboarding';
            END IF;

            -- Store transaction ID to prevent duplicates
            INSERT INTO public.onboarding_transactions (
                transaction_id,
                user_id,
                from_step,
                to_step,
                created_at
            ) VALUES (
                p_transaction_id,
                p_user_id,
                COALESCE(v_current_status.current_step, 'initial'),
                p_current_step,
                NOW()
            );

            -- Update status
            INSERT INTO public.user_onboarding (
                user_id,
                current_step,
                is_complete,
                updated_at
            ) VALUES (
                p_user_id,
                p_current_step,
                p_is_complete,
                NOW()
            )
            ON CONFLICT (user_id) DO UPDATE
            SET
                current_step = EXCLUDED.current_step,
                is_complete = EXCLUDED.is_complete,
                updated_at = EXCLUDED.updated_at
            RETURNING TRUE, 'Update successful', current_step, is_complete;
        END IF;

    EXCEPTION WHEN OTHERS THEN
        -- Rollback transaction
        RAISE EXCEPTION 'Failed to update onboarding status: %', SQLERRM;
    END;
END;
$$;

-- Create table for tracking onboarding transactions
CREATE TABLE IF NOT EXISTS public.onboarding_transactions (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    transaction_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    from_step TEXT NOT NULL,
    to_step TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(transaction_id)
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_onboarding_transactions_user_id 
ON public.onboarding_transactions(user_id);

-- Enable RLS
ALTER TABLE public.onboarding_transactions ENABLE ROW LEVEL SECURITY;

-- Add RLS policies
CREATE POLICY "Users can view their own transactions"
    ON public.onboarding_transactions
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own transactions"
    ON public.onboarding_transactions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id); 