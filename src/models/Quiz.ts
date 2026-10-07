import { Schema, model, Document } from 'mongoose';

export interface IQuestion {
  question: string;
  options: string[];
  correctOption: string; // The correct answer text (matching one of the options)
  timeLimit: number;     // Time limit in seconds (defaults to 10)
}

export interface IQuiz extends Document {
  title: string;
  description?: string;
  creator?: Schema.Types.ObjectId | string; // Reference to User. If null, it's a default system quiz
  questions: IQuestion[];
  price: number;                            // Price in USD ($0 for free/default)
  priceCoins: number;                       // Price in Coins (0 for free, max 10)
  isPublishedToMarketplace: boolean;
  isDefault: boolean;                       // True for Current Affairs, Software Dev testing quizzes
  createdAt: Date;
}

const QuestionSchema = new Schema<IQuestion>({
  question: { type: String, required: true, maxlength: 500 },
  options: [{ type: String, required: true, maxlength: 200 }],
  correctOption: { type: String, required: true, maxlength: 200 },
  timeLimit: { type: Number, default: 10 }
});

const QuizSchema = new Schema<IQuiz>({
  title: { type: String, required: true, maxlength: 120 },
  description: { type: String, maxlength: 1000 },
  creator: { type: Schema.Types.ObjectId, ref: 'User' },
  questions: [QuestionSchema],
  price: { type: Number, default: 0 },
  priceCoins: { type: Number, default: 0, max: 10 },
  isPublishedToMarketplace: { type: Boolean, default: false },
  isDefault: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Covers getUserLibrary/getSellerDashboard's {creator: userId} lookups —
// every host's dashboard load touches this.
QuizSchema.index({ creator: 1 });

// Covers getMarketplaceQuizzes' {isPublishedToMarketplace: true, creator:
// {$ne: userId}} browse query — the public catalog, hit on every
// marketplace page load and only growing as more quizzes get published.
QuizSchema.index({ isPublishedToMarketplace: 1, creator: 1 });

export const Quiz = model<IQuiz>('Quiz', QuizSchema);
