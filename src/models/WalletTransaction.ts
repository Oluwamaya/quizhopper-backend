import { Schema, model, Document } from 'mongoose';

export interface IWalletTransaction extends Document {
  user: Schema.Types.ObjectId;
  type: 'deposit' | 'buy_coins' | 'host_game' | 'marketplace_buy' | 'marketplace_sale' | 'withdrawal' | 'signup_bonus';
  amountMoney: number; // in Naira ₦
  coinsChange: number; // e.g. +10 or -10
  description: string;
  reference?: string;
  status: 'pending' | 'completed' | 'failed';
  createdAt: Date;
}

const WalletTransactionSchema = new Schema<IWalletTransaction>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { 
    type: String, 
    enum: ['deposit', 'buy_coins', 'host_game', 'marketplace_buy', 'marketplace_sale', 'withdrawal', 'signup_bonus'],
    required: true 
  },
  amountMoney: { type: Number, default: 0 },
  coinsChange: { type: Number, default: 0 },
  description: { type: String, required: true },
  reference: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
  createdAt: { type: Date, default: Date.now }
});

// Prevent the same payment-provider reference from ever being credited
// twice, even under concurrent requests (sparse: most transaction types
// have no reference at all).
WalletTransactionSchema.index({ reference: 1 }, { unique: true, sparse: true });

export const WalletTransaction = model<IWalletTransaction>('WalletTransaction', WalletTransactionSchema);
