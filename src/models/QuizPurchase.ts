import { Schema, model, Document } from 'mongoose';

export interface IQuizPurchase extends Document {
  buyer: Schema.Types.ObjectId | string;
  quiz: Schema.Types.ObjectId | string;
  pricePaid: number;
  createdAt: Date;
}

const QuizPurchaseSchema = new Schema<IQuizPurchase>({
  buyer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true },
  pricePaid: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Ensure a user can only buy a specific quiz once
QuizPurchaseSchema.index({ buyer: 1, quiz: 1 }, { unique: true });

// The {buyer, quiz} compound index above can't efficiently serve a
// quiz-only lookup (quiz isn't the prefix key) — this covers
// getSellerDashboard's {quiz: {$in: quizIds}} earnings/sales queries.
QuizPurchaseSchema.index({ quiz: 1 });

export const QuizPurchase = model<IQuizPurchase>('QuizPurchase', QuizPurchaseSchema);
