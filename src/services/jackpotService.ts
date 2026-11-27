import crypto from 'crypto';
import { Server } from 'socket.io';
import { IQuestion } from '../models/Quiz';
import { GameSession, IGameSession, IJackpotWinner } from '../models/GameSession';
import { JackpotEntry } from '../models/JackpotEntry';
import { User } from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import { emitAdminTransaction, emitWalletUpdate } from '../utils/adminEvents';
import { sendJackpotRefundEmail, sendJackpotWinnerEmail } from './emailService';

// Cryptographically unbiased Fisher-Yates shuffle
export const shuffleArray = <T>(items: T[]): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

// Randomizes both question order and each question's answer option order.
// `correctOption` is matched by exact text throughout the codebase, so
// shuffling options is always safe.
export const buildRandomizedQuestions = (questions: IQuestion[], defaultTimeLimit?: number): IQuestion[] => {
  const shuffledQuestions = shuffleArray(questions);
  return shuffledQuestions.map((q) => ({
    question: q.question.trim(),
    options: shuffleArray(q.options.map((o) => o.trim())),
    correctOption: q.correctOption.trim(),
    timeLimit: Number.isFinite(q.timeLimit) && q.timeLimit >= 5 && q.timeLimit <= 120
      ? Math.floor(q.timeLimit)
      : (defaultTimeLimit && defaultTimeLimit >= 5 && defaultTimeLimit <= 120 ? Math.floor(defaultTimeLimit) : 15)
  }));
};

// Returns the authoritative question list for a session: Jackpot sessions use
// their per-session randomized snapshot; standard v1 sessions use the quiz doc.
export const getSessionQuestions = (session: any, fallbackQuiz?: any): IQuestion[] => {
  if (Array.isArray(session?.randomizedQuestions) && session.randomizedQuestions.length > 0) {
    return session.randomizedQuestions;
  }
  return fallbackQuiz?.questions || [];
};

// Computes a player's total answer time across all questions in the quiz.
// Unanswered / timed-out questions incur the full question timeLimit so
// skipping a question can never yield a lower total time than answering.
export const computePlayerTotalTimeMs = (player: any, questions: IQuestion[]): number => {
  const answersByIndex = new Map<number, any>();
  for (const ans of player.answers || []) {
    answersByIndex.set(ans.questionIndex, ans);
  }

  let totalMs = 0;
  for (let i = 0; i < questions.length; i++) {
    const qLimitMs = (questions[i]?.timeLimit || 15) * 1000;
    const ans = answersByIndex.get(i);
    if (ans && typeof ans.timeTakenMs === 'number' && Number.isFinite(ans.timeTakenMs)) {
      totalMs += Math.max(0, Math.min(Math.round(ans.timeTakenMs), qLimitMs));
    } else {
      totalMs += qLimitMs;
    }
  }
  return totalMs;
};

// Determines when a player finished answering (timestamp of their latest
// submitted answer, falling back to joinedAt if they submitted none).
export const getPlayerFinishedAt = (player: any): Date => {
  if (player.lastAnswerAt) {
    return new Date(player.lastAnswerAt);
  }
  const answers = player.answers || [];
  if (answers.length > 0) {
    let latestMs = 0;
    for (const ans of answers) {
      const ts = ans.submittedAt ? new Date(ans.submittedAt).getTime() : 0;
      if (ts > latestMs) latestMs = ts;
    }
    if (latestMs > 0) return new Date(latestMs);
  }
  return new Date(player.joinedAt || Date.now());
};

export interface RankedPlayerEntry {
  player: any;
  score: number;
  totalAnswerTimeMs: number;
  finishedAt: Date;
}

// Ranks players by:
// 1. Higher score
// 2. Lower total answer time (ms)
// 3. Earlier finish timestamp
// 4. Earlier lobby join (deterministic fallback)
export const rankJackpotPlayers = (players: any[], questions: IQuestion[]): RankedPlayerEntry[] => {
  const enriched: RankedPlayerEntry[] = (players || []).map((player) => ({
    player,
    score: player.score || 0,
    totalAnswerTimeMs: computePlayerTotalTimeMs(player, questions),
    finishedAt: getPlayerFinishedAt(player)
  }));

  enriched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.totalAnswerTimeMs !== b.totalAnswerTimeMs) return a.totalAnswerTimeMs - b.totalAnswerTimeMs;
    const finishDiff = a.finishedAt.getTime() - b.finishedAt.getTime();
    if (finishDiff !== 0) return finishDiff;
    const aJoin = new Date(a.player.joinedAt || 0).getTime();
    const bJoin = new Date(b.player.joinedAt || 0).getTime();
    return aJoin - bJoin;
  });

  return enriched;
};

// Computes the Top 5 winners enriched with authoritative User contact details
// (displayName, email, phone) for manual admin payout.
export const buildTop5Winners = async (session: any, questions: IQuestion[]): Promise<IJackpotWinner[]> => {
  const ranked = rankJackpotPlayers(session.players || [], questions).slice(0, 5);
  const userIds = ranked
    .map((entry) => entry.player.userId)
    .filter((id) => Boolean(id));

  const users = userIds.length > 0
    ? await User.find({ _id: { $in: userIds } }).select('displayName email phone avatarUrl')
    : [];
  const userMap = new Map<string, any>(users.map((u) => [String(u._id), u]));

  return ranked.map((entry, idx) => {
    const uid = entry.player.userId ? String(entry.player.userId) : undefined;
    const userDoc = uid ? userMap.get(uid) : null;
    return {
      rank: idx + 1,
      userId: entry.player.userId,
      displayName: userDoc?.displayName || entry.player.nickname,
      nickname: entry.player.nickname,
      email: userDoc?.email || '',
      phone: userDoc?.phone || '',
      avatar: entry.player.avatar,
      score: entry.score,
      totalAnswerTimeMs: entry.totalAnswerTimeMs,
      finishedAt: entry.finishedAt
    };
  });
};

// Public/player-safe view of a live Jackpot Room (never includes questions/answers)
export const serializeLiveJackpotRoom = (session: any, currentUserId?: string) => {
  const players = session.players || [];
  const paidCount = Math.max(session.jackpot?.paidSeatsCount ?? 0, players.length);
  const limit = session.playerLimit || 10;
  const spotsLeft = Math.max(0, limit - paidCount);
  const matchedPlayer = currentUserId
    ? players.find((p: any) => p.userId && String(p.userId) === String(currentUserId))
    : null;

  return {
    id: String(session._id),
    gamePin: matchedPlayer ? session.gamePin : undefined,
    title: session.jackpot?.title || 'Jackpot Room',
    prizeLabel: session.jackpot?.prizeLabel || '',
    entryCostCoins: session.jackpot?.entryCostCoins ?? 3,
    playerLimit: limit,
    playersJoined: paidCount,
    spotsLeft,
    isFull: paidCount >= limit,
    state: session.state,
    totalQuestions: Array.isArray(session.randomizedQuestions) ? session.randomizedQuestions.length : 0,
    defaultTimeLimit: session.jackpot?.defaultTimeLimit ?? 15,
    hasJoined: Boolean(matchedPlayer),
    myNickname: matchedPlayer?.nickname,
    myAvatar: matchedPlayer?.avatar,
    createdAt: session.createdAt
  };
};

// Notify all connected clients whenever live Jackpot room availability/counts change
export const emitJackpotLiveUpdate = (io: Server | undefined | null) => {
  if (!io) return;
  io.emit('jackpot_live_updated', { timestamp: Date.now() });
};

// Atomically and idempotently refund a single paid JackpotEntry (used when
// admin removes a player from a Jackpot lobby before the game starts).
export const refundSingleJackpotEntry = async (
  io: Server | undefined | null,
  sessionId: string,
  userId: string,
  title: string,
  reason: string
): Promise<{ refunded: boolean; coinsRefunded: number }> => {
  const now = new Date();
  const entry = await JackpotEntry.findOneAndUpdate(
    { gameSession: sessionId, user: userId, status: 'paid' },
    { $set: { status: 'refunded', refundedAt: now } },
    { new: true }
  );

  if (!entry) {
    return { refunded: false, coinsRefunded: 0 };
  }

  // Free the seat count on the session
  await GameSession.updateOne(
    { _id: sessionId, 'jackpot.paidSeatsCount': { $gt: 0 } },
    { $inc: { 'jackpot.paidSeatsCount': -1 } }
  );

  if (entry.coinsPaid > 0) {
    const reference = `jackpot_refund:${sessionId}:${userId}:${entry._id}`;
    try {
      const txn = await WalletTransaction.create({
        user: entry.user,
        type: 'jackpot_refund',
        amountMoney: 0,
        coinsChange: entry.coinsPaid,
        description: `Refund for Jackpot Room "${title}" (${reason})`,
        reference,
        status: 'completed'
      });

      const updatedUser = await User.findByIdAndUpdate(
        entry.user,
        { $inc: { coins: entry.coinsPaid } },
        { new: true }
      );

      emitAdminTransaction(io, txn);
      emitWalletUpdate(io, String(entry.user), { coins: updatedUser?.coins });
      if (updatedUser?.email) {
        sendJackpotRefundEmail({
          to: updatedUser.email,
          name: updatedUser.displayName || entry.nickname,
          roomTitle: title,
          coinsRefunded: entry.coinsPaid,
          reason
        }).catch(() => {});
      }
    } catch (err: any) {
      if (err.code !== 11000) throw err; // already refunded
    }
  }

  return { refunded: true, coinsRefunded: entry.coinsPaid };
};

// Atomically cancels a non-finished Jackpot Room and refunds every paid entry
// exactly once. Safe to call concurrently from admin cancel, host_close_room,
// or the inactivity cleanup cron.
export const cancelAndRefundJackpotRoom = async (
  io: Server | undefined | null,
  sessionIdOrPin: { sessionId?: string; gamePin?: string },
  reason: string
): Promise<{ session: IGameSession | null; refundedCount: number; totalCoinsRefunded: number }> => {
  const filter: any = { isJackpot: true };
  if (sessionIdOrPin.sessionId) filter._id = sessionIdOrPin.sessionId;
  else if (sessionIdOrPin.gamePin) filter.gamePin = sessionIdOrPin.gamePin;
  else return { session: null, refundedCount: 0, totalCoinsRefunded: 0 };

  const now = new Date();

  // Transition any unfinished Jackpot room to CANCELLED. Never cancel a FINISHED room.
  let session = await GameSession.findOneAndUpdate(
    { ...filter, state: { $in: ['LOBBY', 'QUESTION_ACTIVE', 'SCOREBOARD'] } },
    {
      $set: {
        state: 'CANCELLED',
        finishedAt: now,
        'jackpot.cancelReason': reason,
        'jackpot.refundProcessedAt': now
      }
    },
    { new: true }
  );

  if (!session) {
    // Already cancelled? Check if any unpaid refund entries remain (crash recovery)
    const existing = await GameSession.findOne(filter);
    if (!existing || existing.state !== 'CANCELLED') {
      return { session: existing, refundedCount: 0, totalCoinsRefunded: 0 };
    }
    session = existing;
  }

  const title = session.jackpot?.title || 'Jackpot Room';
  const paidEntries = await JackpotEntry.find({ gameSession: session._id, status: 'paid' });

  let refundedCount = 0;
  let totalCoinsRefunded = 0;

  for (const candidate of paidEntries) {
    // Atomic claim per entry ensures zero double-refunds even under concurrent calls
    const claimed = await JackpotEntry.findOneAndUpdate(
      { _id: candidate._id, status: 'paid' },
      { $set: { status: 'refunded', refundedAt: now } },
      { new: true }
    );
    if (!claimed) continue;

    refundedCount++;
    if (claimed.coinsPaid > 0) {
      const reference = `jackpot_refund:${session._id}:${claimed.user}:${claimed._id}`;
      try {
        const txn = await WalletTransaction.create({
          user: claimed.user,
          type: 'jackpot_refund',
          amountMoney: 0,
          coinsChange: claimed.coinsPaid,
          description: `Auto-refund for cancelled Jackpot Room "${title}" (${reason})`,
          reference,
          status: 'completed'
        });

        const updatedUser = await User.findByIdAndUpdate(
          claimed.user,
          { $inc: { coins: claimed.coinsPaid } },
          { new: true }
        );

        totalCoinsRefunded += claimed.coinsPaid;
        emitAdminTransaction(io, txn);
        emitWalletUpdate(io, String(claimed.user), { coins: updatedUser?.coins });
        if (updatedUser?.email) {
          sendJackpotRefundEmail({
            to: updatedUser.email,
            name: updatedUser.displayName || claimed.nickname,
            roomTitle: title,
            coinsRefunded: claimed.coinsPaid,
            reason
          }).catch(() => {});
        }
      } catch (err: any) {
        if (err.code !== 11000) {
          console.error(`Failed refunding JackpotEntry ${claimed._id}:`, err);
        }
      }
    }
  }

  emitJackpotLiveUpdate(io);
  return { session, refundedCount, totalCoinsRefunded };
};

// Fire-and-forget ZeptoMail notification to each Top 5 winner after a Jackpot completes.
export const notifyJackpotWinnersByEmail = (
  roomTitle: string,
  prizeLabel: string,
  winners: IJackpotWinner[]
) => {
  if (!Array.isArray(winners) || winners.length === 0) return;
  Promise.allSettled(
    winners
      .filter((w) => w.email)
      .map((w) =>
        sendJackpotWinnerEmail({
          to: w.email,
          name: w.displayName || w.nickname,
          rank: w.rank,
          roomTitle,
          prizeLabel,
          score: w.score,
          totalAnswerTimeMs: w.totalAnswerTimeMs
        })
      )
  ).catch(() => {});
};
