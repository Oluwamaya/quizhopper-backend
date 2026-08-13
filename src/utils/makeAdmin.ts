import mongoose from 'mongoose';
import { User } from '../models/User';
import { env } from '../config/env';

const makeAdmin = async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Please specify an email address. Usage: npx ts-node src/utils/makeAdmin.ts <email>');
    process.exit(1);
  }

  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('Connected to MongoDB database.');

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      console.error(`User with email "${email}" not found in the database. Please sign up first.`);
      process.exit(1);
    }

    user.isAdmin = true;
    await user.save();

    console.log(`\n======================================================`);
    console.log(`SUCCESS: "${user.displayName}" (${user.email}) is now an Administrator!`);
    console.log(`======================================================\n`);
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error during promotion:', err);
    process.exit(1);
  }
};

makeAdmin();
