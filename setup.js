import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './models/User.js';

dotenv.config();

const setupAdmin = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI.replace(
      '<db_password>',
      process.env.MONGODB_PASSWORD
    );

    await mongoose.connect(mongoURI);
    console.log('Connected to MongoDB');

    // Check if admin exists
    const adminExists = await User.findOne({ email: 'admin@example.com' });

    if (adminExists) {
      console.log('Admin user already exists');
      process.exit(0);
    }

    // Create admin user
    const adminUser = new User({
      email: 'admin@example.com',
      password: 'admin123', // This will be hashed by the pre-save hook
      name: 'Admin User',
      role: 'admin'
    });

    await adminUser.save();
    console.log('Admin user created successfully');
    process.exit(0);
  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
};

setupAdmin();