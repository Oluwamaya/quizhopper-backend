import { Schema, model, Document } from 'mongoose';

export interface IPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    auth: string;
    p256dh: string;
  };
}

export interface IUser extends Document {
  displayName: string;
  email: string;
  avatarUrl?: string;
  googleId?: string;
  password?: string; // Optional for standard Email/Password accounts
  isPremium: boolean;
  isAdmin: boolean;
  balance: number;      // Earnings from marketplace sales (in USD)
  coins: number;        // Credits to host games beyond limit
  salesCount: number;   // Total copy count of quizzes sold
  pushSubscriptions: IPushSubscription[];
  createdAt: Date;
}

const PushSubscriptionSchema = new Schema<IPushSubscription>({
  endpoint: { type: String, required: true },
  expirationTime: { type: Number, default: null },
  keys: {
    auth: { type: String, required: true },
    p256dh: { type: String, required: true }
  }
});

const UserSchema = new Schema<IUser>({
  displayName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  avatarUrl: { type: String },
  googleId: { type: String, unique: true, sparse: true },
  password: { type: String },
  isPremium: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  balance: { type: Number, default: 0 },
  coins: { type: Number, default: 0 },
  salesCount: { type: Number, default: 0 },
  pushSubscriptions: [PushSubscriptionSchema],
  createdAt: { type: Date, default: Date.now }
});

export const User = model<IUser>('User', UserSchema);
