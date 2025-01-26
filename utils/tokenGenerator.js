import { adminClient } from './supabase.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { logger } from './logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const TOKEN_EXPIRY = '24h';

async function generateAccessToken(email, password) {
    try {
        // 1. Fetch user from database
        const { data: user, error: userError } = await adminClient
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (userError || !user) {
            logger.error('[Token Generator] User not found:', { email, error: userError?.message });
            throw new Error('Invalid credentials');
        }

        // 2. Verify password - handle both hashed and plain text passwords
        let isValidPassword = false;
        
        if (user.password_hash) {
            // If password is hashed
            isValidPassword = await bcrypt.compare(password, user.password_hash);
        } else if (user.password) {
            // If password is stored in plain text (for testing)
            isValidPassword = password === user.password;
        }

        if (!isValidPassword) {
            logger.error('[Token Generator] Invalid password for user:', { email });
            throw new Error('Invalid credentials');
        }

        // 3. Generate JWT token
        const token = jwt.sign(
            {
                userId: user.id,
                email: user.email,
                role: user.role || 'user'
            },
            JWT_SECRET,
            { expiresIn: TOKEN_EXPIRY }
        );

        logger.info('[Token Generator] Access token generated successfully for:', { email });

        return {
            token,
            user: {
                id: user.id,
                email: user.email,
                role: user.role || 'user'
            }
        };
    } catch (error) {
        logger.error('[Token Generator] Error generating token:', { 
            email, 
            error: error.message 
        });
        throw error;
    }
}

export { generateAccessToken };