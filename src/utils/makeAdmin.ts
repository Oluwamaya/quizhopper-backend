import mongoose from 'mongoose';
import { User } from '../models/User';
import { env } from '../config/env';

const makeAdmin = async () => {
  const args = process.argv.slice(2);
  const promoteSuper = args.includes('--super');
  const email = args.find((arg) => !arg.startsWith('--'));
  if (!email) {
    console.error('Usage: npx ts-node src/utils/makeAdmin.ts <email> [--super]');
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
    if (promoteSuper) {
      user.isSuperAdmin = true;
    }
    await user.save();

    console.log(`\n======================================================`);
    console.log(
      promoteSuper
        ? `SUCCESS: "${user.displayName}" (${user.email}) is now a SUPER ADMINISTRATOR!`
        : `SUCCESS: "${user.displayName}" (${user.email}) is now a Jackpot Administrator!`
    );
    console.log(`======================================================\n`);
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error during promotion:', err);
    process.exit(1);
  }
};

makeAdmin();
