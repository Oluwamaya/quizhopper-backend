import mongoose from 'mongoose';
import { env } from './env';
import { User } from '../models/User';

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('MongoDB successfully connected!');

    // One-time bootstrap: if no Super Admin exists yet, upgrade the earliest
    // existing Admin account so the platform owner is never locked out after
    // introducing the Admin vs Super Admin role split.
    const hasSuperAdmin = await User.exists({ isSuperAdmin: true });
    if (!hasSuperAdmin) {
      const firstAdmin = await User.findOne({ isAdmin: true }).sort({ createdAt: 1 });
      if (firstAdmin) {
        firstAdmin.isSuperAdmin = true;
        await firstAdmin.save();
        console.log(`[Bootstrap] Promoted existing admin "${firstAdmin.email}" to Super Admin.`);
      }
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};
