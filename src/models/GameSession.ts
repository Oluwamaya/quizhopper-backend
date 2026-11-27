import { Schema, model, Document } from 'mongoose';
import { IQuestion } from './Quiz';

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
  userId?: Schema.Types.ObjectId | string;
  nickname: string;
  avatar: string;
  score: number;
  answers: IPlayerAnswer[];
  totalAnswerTimeMs?: number;
  lastAnswerAt?: Date;
  joinedAt: Date;
  mutedInChat?: boolean;
}

export interface IJackpotWinner {
  rank: number;
  userId?: Schema.Types.ObjectId | string;
  displayName: string;
  nickname: string;
  email: string;
  phone?: string;
  avatar: string;
  score: number;
  totalAnswerTimeMs: number;
  finishedAt: Date;
}

export interface IJackpotMeta {
  title: string;
  prizeLabel: string;
  entryCostCoins: number;
  paidSeatsCount: number;
  defaultTimeLimit: number;
  cancelReason?: string;
  refundProcessedAt?: Date;
  winners: IJackpotWinner[];
}

export interface IGameSession extends Document {
  gamePin: string; // 6-digit room code
  host: Schema.Types.ObjectId | string;
  quiz: Schema.Types.ObjectId | string;
  state: 'LOBBY' | 'QUESTION_ACTIVE' | 'SCOREBOARD' | 'FINISHED' | 'CANCELLED';
  currentQuestionIndex: number;
  questionActiveSince?: Date; // Timestamp when current question timer started
  players: IPlayer[];
  backgroundMusic?: string; // e.g. 'song1.mp3' or 'off'
  playerLimit: number;
  chatEnabled: boolean; // Host-controlled; defaults on. Chat messages
                        // themselves are never persisted anywhere — live
                        // broadcast only — so only this on/off flag lives here.
  isJackpot: boolean;
  jackpot?: IJackpotMeta;
  randomizedQuestions?: IQuestion[];
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
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  nickname: { type: String, required: true },
  avatar: { type: String, required: true },
  score: { type: Number, default: 0 },
  answers: [PlayerAnswerSchema],
  totalAnswerTimeMs: { type: Number, default: 0 },
  lastAnswerAt: { type: Date },
  joinedAt: { type: Date, default: Date.now },
  mutedInChat: { type: Boolean, default: false }
});

const JackpotWinnerSchema = new Schema<IJackpotWinner>({
  rank: { type: Number, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  displayName: { type: String, required: true },
  nickname: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  avatar: { type: String, required: true },
  score: { type: Number, required: true },
  totalAnswerTimeMs: { type: Number, required: true },
  finishedAt: { type: Date, required: true }
}, { _id: false });

const JackpotMetaSchema = new Schema<IJackpotMeta>({
  title: { type: String, required: true, maxlength: 120 },
  prizeLabel: { type: String, required: true, maxlength: 120 },
  entryCostCoins: { type: Number, required: true, default: 3, min: 0 },
  paidSeatsCount: { type: Number, default: 0, min: 0 },
  defaultTimeLimit: { type: Number, default: 15, min: 5, max: 120 },
  cancelReason: { type: String },
  refundProcessedAt: { type: Date },
  winners: [JackpotWinnerSchema]
}, { _id: false });

const SessionQuestionSchema = new Schema<IQuestion>({
  question: { type: String, required: true, maxlength: 500 },
  options: [{ type: String, required: true, maxlength: 200 }],
  correctOption: { type: String, required: true, maxlength: 200 },
  timeLimit: { type: Number, default: 15 }
}, { _id: false });

const GameSessionSchema = new Schema<IGameSession>({
  gamePin: { type: String, required: true, unique: true },
  host: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true },
  state: { type: String, enum: ['LOBBY', 'QUESTION_ACTIVE', 'SCOREBOARD', 'FINISHED', 'CANCELLED'], default: 'LOBBY' },
  currentQuestionIndex: { type: Number, default: 0 },
  questionActiveSince: { type: Date },
  players: [PlayerSchema],
  backgroundMusic: { type: String, default: 'off' },
  playerLimit: { type: Number, default: 10 },
  chatEnabled: { type: Boolean, default: true },
  isJackpot: { type: Boolean, default: false },
  jackpot: { type: JackpotMetaSchema },
  randomizedQuestions: [SessionQuestionSchema],
  createdAt: { type: Date, default: Date.now },
  finishedAt: { type: Date }
});

// Covers getGameHistory's exact query shape ({host, state: 'FINISHED'} sorted
// by finishedAt) in a single index — without it, every hosted-history page
// view does a full collection scan, which only gets slower as this
// collection grows (one document per game ever played, across every user).
GameSessionSchema.index({ host: 1, state: 1, finishedAt: -1 });

// Covers the inactivity cleanup cron's {state: {$ne: 'FINISHED'}} scan,
// which runs every 5 minutes against the whole collection. As FINISHED
// sessions accumulate indefinitely (nothing currently purges them), an
// unindexed scan here gets proportionally slower over the app's lifetime
// even though the actual non-finished result set stays small.
GameSessionSchema.index({ state: 1 });

// Covers live Jackpot card queries and admin Jackpot room listings.
GameSessionSchema.index({ isJackpot: 1, state: 1, createdAt: -1 });

export const GameSession = model<IGameSession>('GameSession', GameSessionSchema);
