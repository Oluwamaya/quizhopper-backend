import { Schema, model, Document } from 'mongoose';

export interface IJackpotEntry extends Document {
  gameSession: Schema.Types.ObjectId;
  user: Schema.Types.ObjectId;
  nickname: string;
  avatar: string;
  coinsPaid: number;
  status: 'paid' | 'refunded';
  paidAt: Date;
  refundedAt?: Date;
}

const JackpotEntrySchema = new Schema<IJackpotEntry>({
  gameSession: { type: Schema.Types.ObjectId, ref: 'GameSession', required: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  nickname: { type: String, required: true, maxlength: 32 },
  avatar: { type: String, required: true, maxlength: 1000 },
  coinsPaid: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['paid', 'refunded'], default: 'paid' },
  paidAt: { type: Date, default: Date.now },
  refundedAt: { type: Date }
});

// Enforces 1 seat per user per Jackpot Room at the database layer so
// concurrent join attempts can never double-book or double-charge a player.
JackpotEntrySchema.index({ gameSession: 1, user: 1 }, { unique: true });

export const JackpotEntry = model<IJackpotEntry>('JackpotEntry', JackpotEntrySchema);
