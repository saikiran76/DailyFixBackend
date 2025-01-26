import { generateAccessToken } from '../utils/tokenGenerator.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
    try {
        const email = 'ksknew76105@gmail.com';
        const password = 'Koradatech@76105';

        console.log('\nAttempting to generate access token...');
        console.log('Email:', email);
        
        const result = await generateAccessToken(email, password);
        
        console.log('\n✅ Access Token Generated Successfully');
        console.log('=====================================');
        console.log('\nToken:');
        console.log('------');
        console.log(result.token);
        
        console.log('\nUser Details:');
        console.log('-------------');
        console.log(JSON.stringify(result.user, null, 2));
        
        // Save token to file for easy access
        const fs = await import('fs');
        await fs.promises.writeFile('./.token', result.token);
        console.log('\nToken has been saved to .token file');
        
    } catch (error) {
        console.error('\n❌ Error generating token:', error.message);
        if (error.message === 'Invalid credentials') {
            console.log('\nPlease check your email and password.');
        }
        process.exit(1);
    }
}

main();