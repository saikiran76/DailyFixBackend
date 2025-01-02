-- Create stored procedure for atomic onboarding status updates
CREATE OR REPLACE FUNCTION public.update_onboarding_status(
    p_user_id UUID,
    p_is_complete BOOLEAN,
    p_current_step TEXT,
    p_updated_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.user_onboarding (
        user_id,
        is_complete,
        current_step,
        updated_at
    )
    VALUES (
        p_user_id,
        p_is_complete,
        p_current_step,
        p_updated_at
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
        is_complete = EXCLUDED.is_complete,
        current_step = EXCLUDED.current_step,
        updated_at = EXCLUDED.updated_at;
END;
$$; 