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
  isPublishedToMarketplace: boolean;
  isDefault: boolean;                       // True for Current Affairs, Software Dev testing quizzes
  createdAt: Date;
}

const QuestionSchema = new Schema<IQuestion>({
  question: { type: String, required: true },
  options: [{ type: String, required: true }],
  correctOption: { type: String, required: true },
  timeLimit: { type: Number, default: 10 }
});

const QuizSchema = new Schema<IQuiz>({
  title: { type: String, required: true },
  description: { type: String },
  creator: { type: Schema.Types.ObjectId, ref: 'User' },
  questions: [QuestionSchema],
  price: { type: Number, default: 0 },
  isPublishedToMarketplace: { type: Boolean, default: false },
  isDefault: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export const Quiz = model<IQuiz>('Quiz', QuizSchema);
