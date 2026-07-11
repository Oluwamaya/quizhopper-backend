import { Schema, model, Document } from 'mongoose';

export interface IPlayerAnswer {
  questionIndex: number;
  selectedAnswer: string;
  isCorrect: boolean;
  scoreAwarded: number;
  timeTakenMs: number;
  submittedAt: Date;
}

export interface IPlayer {
  socketId?: string;
  nickname: string;
  avatar: string;
  score: number;
  answers: IPlayerAnswer[];
  joinedAt: Date;
}

export interface IGameSession extends Document {
  gamePin: string; // 6-digit room code
  host: Schema.Types.ObjectId | string;
  quiz: Schema.Types.ObjectId | string;
  state: 'LOBBY' | 'QUESTION_ACTIVE' | 'SCOREBOARD' | 'FINISHED';
  currentQuestionIndex: number;
  questionActiveSince?: Date; // Timestamp when current question timer started
  players: IPlayer[];
  backgroundMusic?: string; // e.g. 'song1.mp3' or 'off'
  playerLimit: number;
  createdAt: Date;
  finishedAt?: Date;
}

const PlayerAnswerSchema = new Schema<IPlayerAnswer>({
  questionIndex: { type: Number, required: true },
  selectedAnswer: { type: String, required: true },
  isCorrect: { type: Boolean, required: true },
  scoreAwarded: { type: Number, required: true },
  timeTakenMs: { type: Number, required: true },
  submittedAt: { type: Date, default: Date.now }
});

const PlayerSchema = new Schema<IPlayer>({
  socketId: { type: String },
  nickname: { type: String, required: true },
  avatar: { type: String, required: true },
  score: { type: Number, default: 0 },
  answers: [PlayerAnswerSchema],
  joinedAt: { type: Date, default: Date.now }
});

const GameSessionSchema = new Schema<IGameSession>({
  gamePin: { type: String, required: true, unique: true },
  host: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true },
  state: { type: String, enum: ['LOBBY', 'QUESTION_ACTIVE', 'SCOREBOARD', 'FINISHED'], default: 'LOBBY' },
  currentQuestionIndex: { type: Number, default: 0 },
  questionActiveSince: { type: Date },
  players: [PlayerSchema],
  backgroundMusic: { type: String, default: 'off' },
  playerLimit: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now },
  finishedAt: { type: Date }
});

export const GameSession = model<IGameSession>('GameSession', GameSessionSchema);
