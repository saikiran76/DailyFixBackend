-- Create table for tracking onboarding transactions
CREATE TABLE IF NOT EXISTS public.onboarding_transactions (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    transaction_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    from_step TEXT NOT NULL,
    to_step TEXT NOT NULL,
    is_rollback BOOLEAN DEFAULT FALSE,
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

-- Add function to handle atomic onboarding updates
CREATE OR REPLACE FUNCTION public.update_onboarding_status_atomic(
    p_user_id UUID,
    p_current_step TEXT,
    p_previous_step TEXT,
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
    v_current_status RECORD;
BEGIN
    -- Get current status with lock
    SELECT * INTO v_current_status
    FROM public.user_onboarding
    WHERE user_id = p_user_id
    FOR UPDATE;

    -- Handle rollback
    IF p_is_rollback THEN
        IF v_current_status.current_step = p_current_step THEN
            RETURN QUERY SELECT 
                TRUE,
                'No rollback needed - state unchanged',
                v_current_status.current_step,
                v_current_status.is_complete;
            RETURN;
        END IF;

        UPDATE public.user_onboarding
        SET 
            current_step = p_previous_step,
            is_complete = FALSE,
            updated_at = NOW()
        WHERE user_id = p_user_id;

        -- Log rollback
        INSERT INTO public.onboarding_transactions (
            transaction_id,
            user_id,
            from_step,
            to_step,
            is_rollback
        ) VALUES (
            p_transaction_id || '_rollback',
            p_user_id,
            v_current_status.current_step,
            p_previous_step,
            TRUE
        );

        RETURN QUERY SELECT 
            TRUE,
            'Rollback successful',
            p_previous_step,
            FALSE;
    ELSE
        -- Prevent duplicate transactions
        IF EXISTS (
            SELECT 1 FROM public.onboarding_transactions
            WHERE transaction_id = p_transaction_id
        ) THEN
            RAISE EXCEPTION 'Transaction already processed';
        END IF;

        -- Log transaction
        INSERT INTO public.onboarding_transactions (
            transaction_id,
            user_id,
            from_step,
            to_step
        ) VALUES (
            p_transaction_id,
            p_user_id,
            COALESCE(v_current_status.current_step, 'initial'),
            p_current_step
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
            p_current_step = 'complete',
            NOW()
        )
        ON CONFLICT (user_id) DO UPDATE
        SET
            current_step = EXCLUDED.current_step,
            is_complete = EXCLUDED.is_complete,
            updated_at = EXCLUDED.updated_at;

        RETURN QUERY SELECT 
            TRUE,
            'Update successful',
            p_current_step,
            p_current_step = 'complete';
    END IF;
END;
$$; 