import { Response } from 'express';
import { Quiz } from '../models/Quiz';
import { GameSession } from '../models/GameSession';
import { JackpotEntry } from '../models/JackpotEntry';
import { User } from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import { AuthRequest } from '../middlewares/authMiddleware';
import { sendServerError } from '../middlewares/errorHandler';
import { generateQuizQuestions, isAiGenerationConfigured, QuizDifficulty } from '../services/aiQuizService';
import {
  buildRandomizedQuestions,
  cancelAndRefundJackpotRoom,
  emitJackpotLiveUpdate,
  serializeLiveJackpotRoom
} from '../services/jackpotService';
import { emitAdminTransaction, emitWalletUpdate } from '../utils/adminEvents';
import { sendJackpotEntryEmail } from '../services/emailService';
import {
  forceCloseActiveRoom,
  registerActiveRoom,
  syncPaidJackpotPlayerToActiveRoom
} from '../sockets/gameSocket';

const MAX_TITLE_LENGTH = 120;
const MAX_PRIZE_LABEL_LENGTH = 120;
const MAX_QUESTIONS = 100;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTIONS_PER_QUESTION = 8;
const MAX_OPTION_TEXT_LENGTH = 200;
const AI_DIFFICULTIES: QuizDifficulty[] = ['easy', 'medium', 'hard'];

const validateJackpotQuestions = (questions: any, defaultTimeLimit: number): string | null => {
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'At least one question is required';
  }
  if (questions.length > MAX_QUESTIONS) {
    return `A Jackpot Room cannot have more than ${MAX_QUESTIONS} questions`;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q.question !== 'string' || !q.question.trim() || q.question.length > MAX_QUESTION_TEXT_LENGTH) {
      return `Question #${i + 1} must have text under ${MAX_QUESTION_TEXT_LENGTH} characters`;
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > MAX_OPTIONS_PER_QUESTION) {
      return `Question #${i + 1} must have between 2 and ${MAX_OPTIONS_PER_QUESTION} options`;
    }
    if (q.options.some((opt: any) => typeof opt !== 'string' || !opt.trim() || opt.length > MAX_OPTION_TEXT_LENGTH)) {
      return `Each option in Question #${i + 1} must be non-empty and under ${MAX_OPTION_TEXT_LENGTH} characters`;
    }
    const trimmedOpts = q.options.map((o: string) => o.trim());
    if (new Set(trimmedOpts.map((o: string) => o.toLowerCase())).size !== trimmedOpts.length) {
      return `Question #${i + 1} contains duplicate answer options`;
    }
    if (typeof q.correctOption !== 'string' || !trimmedOpts.includes(q.correctOption.trim())) {
      return `The correct option for Question #${i + 1} must match one of the choices`;
    }
    const t = q.timeLimit !== undefined ? Number(q.timeLimit) : defaultTimeLimit;
    if (!Number.isFinite(t) || t < 5 || t > 120) {
      return `Timer for Question #${i + 1} must be between 5 and 120 seconds`;
    }
  }
  return null;
};

const generateUniqueGamePin = async (): Promise<string> => {
  let gamePin = Math.floor(100000 + Math.random() * 900000).toString();
  let existing = await GameSession.findOne({ gamePin, state: { $nin: ['FINISHED', 'CANCELLED'] } });
  while (existing) {
    gamePin = Math.floor(100000 + Math.random() * 900000).toString();
    existing = await GameSession.findOne({ gamePin, state: { $nin: ['FINISHED', 'CANCELLED'] } });
  }
  return gamePin;
};

// 1. PUBLIC (optionalAuth): Get currently live Jackpot rooms for the "Jackpot Live" card
export const getLiveJackpotRooms = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;

    // Everyone sees rooms in LOBBY. Authenticated players who already paid
    // also see active (QUESTION_ACTIVE / SCOREBOARD) rooms they joined so they
    // can seamlessly re-enter if they closed their tab.
    const filter: any = userId
      ? {
          isJackpot: true,
          $or: [
            { state: 'LOBBY' },
            { state: { $in: ['QUESTION_ACTIVE', 'SCOREBOARD'] }, 'players.userId': userId }
          ]
        }
      : { isJackpot: true, state: 'LOBBY' };

    const sessions = await GameSession.find(filter).sort({ createdAt: -1 }).limit(10);
    const rooms = sessions.map((s) => serializeLiveJackpotRoom(s, userId));

    return res.status(200).json({ success: true, rooms });
  } catch (error: any) {
    return sendServerError(res, error, 'getLiveJackpotRooms');
  }
};

// 2. PLAYER (protect): Atomically pay entry coins, claim seat, and join Jackpot Room
export const joinJackpotRoom = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const { nickname: rawNickname, avatar: rawAvatar } = req.body || {};

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    if (user.isAdmin || user.isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin accounts cannot join Jackpot Rooms as players.'
      });
    }

    // Require phone number to be updated in profile before joining so admin
    // always has full contact details to pay Top 5 winners manually.
    const phoneDigits = (user.phone || '').replace(/\D/g, '');
    if (!user.phone || phoneDigits.length < 7) {
      return res.status(400).json({
        success: false,
        code: 'PHONE_REQUIRED',
        message: 'Please add your phone number on your Profile page before joining a Jackpot Room.'
      });
    }

    const session = await GameSession.findOne({ _id: id, isJackpot: true });
    if (!session || !session.jackpot) {
      return res.status(404).json({ success: false, message: 'Jackpot Room not found' });
    }

    // Block duplicate joins — if this user already holds a paid seat, never
    // charge again and let the client know they are already registered.
    const existingEntry = await JackpotEntry.findOne({ gameSession: session._id, user: user._id });
    if (existingEntry) {
      if (existingEntry.status === 'paid') {
        const existingPlayer = session.players.find((p: any) => p.userId && String(p.userId) === String(user._id));
        return res.status(409).json({
          success: false,
          code: 'ALREADY_JOINED',
          alreadyJoined: true,
          message: 'You have already joined this Jackpot Room.',
          gamePin: session.gamePin,
          nickname: existingPlayer?.nickname || existingEntry.nickname,
          avatar: existingPlayer?.avatar || existingEntry.avatar,
          state: session.state,
          jackpot: {
            title: session.jackpot.title,
            prizeLabel: session.jackpot.prizeLabel,
            entryCostCoins: session.jackpot.entryCostCoins,
            playerLimit: session.playerLimit
          }
        });
      }
      return res.status(403).json({
        success: false,
        message: 'Your entry for this Jackpot Room was previously removed and refunded.'
      });
    }

    if (session.state !== 'LOBBY') {
      return res.status(400).json({
        success: false,
        message: 'This Jackpot Room has already started or ended.'
      });
    }

    const entryCost = Math.max(0, Math.floor(session.jackpot.entryCostCoins));
    const chosenNickname = (typeof rawNickname === 'string' && rawNickname.trim())
      ? rawNickname.trim().slice(0, 20)
      : user.displayName.trim().slice(0, 20);
    const chosenAvatar = (typeof rawAvatar === 'string' && rawAvatar.trim())
      ? rawAvatar.trim()
      : (user.avatarUrl || `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(chosenNickname)}`);

    if (chosenNickname.length < 2) {
      return res.status(400).json({ success: false, message: 'Nickname must be at least 2 characters' });
    }

    // Check nickname collision with other players already in the room
    const nickCollision = session.players.some(
      (p: any) => p.nickname.toLowerCase() === chosenNickname.toLowerCase()
    );
    if (nickCollision) {
      return res.status(400).json({ success: false, message: 'That nickname is already taken in this room. Try another.' });
    }

    // Step 1: Atomically claim a seat slot on GameSession (enforces playerLimit & LOBBY state)
    const reservedSession = await GameSession.findOneAndUpdate(
      {
        _id: session._id,
        isJackpot: true,
        state: 'LOBBY',
        $expr: { $lt: ['$jackpot.paidSeatsCount', '$playerLimit'] },
        'players.userId': { $ne: user._id }
      },
      { $inc: { 'jackpot.paidSeatsCount': 1 } },
      { new: true }
    );

    if (!reservedSession) {
      const latest = await GameSession.findById(session._id);
      if (!latest || latest.state !== 'LOBBY') {
        return res.status(400).json({ success: false, message: 'This Jackpot Room is no longer open.' });
      }
      const alreadyIn = latest.players.some((p: any) => p.userId && String(p.userId) === String(user._id));
      if (alreadyIn) {
        return res.status(409).json({ success: false, code: 'ALREADY_JOINED', message: 'You have already joined this Jackpot Room.' });
      }
      return res.status(400).json({
        success: false,
        code: 'ROOM_FULL',
        message: 'Room full! This Jackpot Room has reached its player limit.'
      });
    }

    // Step 2: Claim unique JackpotEntry record before touching coins (blocks concurrent double-joins)
    let entry;
    try {
      entry = await JackpotEntry.create({
        gameSession: session._id,
        user: user._id,
        nickname: chosenNickname,
        avatar: chosenAvatar,
        coinsPaid: entryCost,
        status: 'paid'
      });
    } catch (err: any) {
      await GameSession.updateOne(
        { _id: session._id, 'jackpot.paidSeatsCount': { $gt: 0 } },
        { $inc: { 'jackpot.paidSeatsCount': -1 } }
      );
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_JOINED',
          message: 'You have already joined this Jackpot Room.'
        });
      }
      throw err;
    }

    // Step 3: Atomically deduct coins from User wallet
    let remainingCoins = user.coins;
    const io = req.app.get('socketio');

    if (entryCost > 0) {
      const deductedUser = await User.findOneAndUpdate(
        { _id: user._id, coins: { $gte: entryCost } },
        { $inc: { coins: -entryCost } },
        { new: true }
      );

      if (!deductedUser) {
        // Roll back seat & entry atomically
        await JackpotEntry.deleteOne({ _id: entry._id });
        await GameSession.updateOne(
          { _id: session._id, 'jackpot.paidSeatsCount': { $gt: 0 } },
          { $inc: { 'jackpot.paidSeatsCount': -1 } }
        );
        const freshUser = await User.findById(user._id).select('coins');
        return res.status(400).json({
          success: false,
          code: 'INSUFFICIENT_COINS',
          message: `Insufficient coins. Entry costs ${entryCost} coins, and you currently have ${freshUser?.coins ?? 0} coins.`
        });
      }

      remainingCoins = deductedUser.coins;

      // Step 4: Record WalletTransaction with deterministic unique reference
      try {
        const txn = await WalletTransaction.create({
          user: user._id,
          type: 'jackpot_entry',
          amountMoney: 0,
          coinsChange: -entryCost,
          description: `Joined Jackpot Room "${session.jackpot.title}" (${session.jackpot.prizeLabel})`,
          reference: `jackpot_entry:${session._id}:${user._id}`,
          status: 'completed'
        });
        emitAdminTransaction(io, txn);
      } catch (txnErr: any) {
        if (txnErr.code !== 11000) {
          console.error('Jackpot WalletTransaction error:', txnErr);
        }
      }

      emitWalletUpdate(io, String(user._id), { coins: remainingCoins });
    }

    if (user.email) {
      sendJackpotEntryEmail({
        to: user.email,
        name: user.displayName || chosenNickname,
        roomTitle: session.jackpot.title,
        prizeLabel: session.jackpot.prizeLabel,
        coinsPaid: entryCost
      }).catch(() => {});
    }

    // Step 5: Persist player on GameSession and sync live Socket.IO room cache
    const newPlayer = {
      socketId: '',
      userId: user._id,
      nickname: chosenNickname,
      avatar: chosenAvatar,
      score: 0,
      answers: [],
      totalAnswerTimeMs: 0,
      joinedAt: new Date(),
      mutedInChat: false
    };

    const updatedSession = await GameSession.findByIdAndUpdate(
      session._id,
      { $push: { players: newPlayer } },
      { new: true }
    );

    await syncPaidJackpotPlayerToActiveRoom(io, session.gamePin, newPlayer);
    emitJackpotLiveUpdate(io);

    const playersList = (updatedSession?.players || [newPlayer]).map((p: any) => ({
      nickname: p.nickname,
      avatar: p.avatar
    }));

    return res.status(200).json({
      success: true,
      message: entryCost > 0
        ? `Joined Jackpot Room! ${entryCost} coins deducted.`
        : 'Joined Jackpot Room!',
      gamePin: session.gamePin,
      nickname: chosenNickname,
      avatar: chosenAvatar,
      players: playersList,
      chatEnabled: session.chatEnabled !== false,
      remainingCoins,
      jackpot: {
        id: String(session._id),
        title: session.jackpot.title,
        prizeLabel: session.jackpot.prizeLabel,
        entryCostCoins: entryCost,
        playerLimit: session.playerLimit
      }
    });
  } catch (error: any) {
    return sendServerError(res, error, 'joinJackpotRoom');
  }
};

// 3. ADMIN: Generate Jackpot questions with AI (0 coin cost for admins, returned for review/edit)
export const adminGenerateJackpotQuestions = async (req: AuthRequest, res: Response) => {
  try {
    const { topic, description, numQuestions, difficulty, defaultTimeLimit } = req.body || {};

    if (!topic || typeof topic !== 'string' || !topic.trim() || topic.length > 200) {
      return res.status(400).json({ success: false, message: 'Topic is required and must be under 200 characters' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 1000)) {
      return res.status(400).json({ success: false, message: 'Description must be under 1000 characters' });
    }
    const count = Number(numQuestions);
    if (!Number.isInteger(count) || count < 1 || count > 25) {
      return res.status(400).json({ success: false, message: 'Number of questions must be an integer between 1 and 25' });
    }
    if (typeof difficulty !== 'string' || !AI_DIFFICULTIES.includes(difficulty as QuizDifficulty)) {
      return res.status(400).json({ success: false, message: 'Difficulty must be easy, medium, or hard' });
    }
    if (!isAiGenerationConfigured()) {
      return res.status(503).json({ success: false, message: 'AI quiz generation is not configured on the server.' });
    }

    const generated = await generateQuizQuestions({
      topic: topic.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      numQuestions: count,
      difficulty: difficulty as QuizDifficulty
    });

    const timerOverride = Number(defaultTimeLimit);
    const hasTimerOverride = Number.isFinite(timerOverride) && timerOverride >= 5 && timerOverride <= 120;

    const questions = generated.map((q) => ({
      ...q,
      timeLimit: hasTimerOverride ? Math.floor(timerOverride) : q.timeLimit
    }));

    return res.status(200).json({
      success: true,
      message: `Generated ${questions.length} questions — review and edit before creating the Jackpot Room.`,
      questions
    });
  } catch (error: any) {
    console.error('adminGenerateJackpotQuestions failed:', error);
    return res.status(502).json({
      success: false,
      message: error?.message || 'AI question generation failed. Please try again.'
    });
  }
};

// 4. ADMIN: Create and open a live Jackpot Room (no hosting coin charge for admin)
export const adminCreateJackpotRoom = async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.userId!;
    const {
      title,
      prizeLabel,
      playerLimit,
      entryCostCoins,
      defaultTimeLimit,
      questions
    } = req.body || {};

    if (!title || typeof title !== 'string' || !title.trim() || title.trim().length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ success: false, message: `Title is required and must be under ${MAX_TITLE_LENGTH} characters` });
    }
    if (!prizeLabel || typeof prizeLabel !== 'string' || !prizeLabel.trim() || prizeLabel.trim().length > MAX_PRIZE_LABEL_LENGTH) {
      return res.status(400).json({ success: false, message: `Jackpot prize label/amount is required and must be under ${MAX_PRIZE_LABEL_LENGTH} characters` });
    }

    const parsedLimit = Number(playerLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 2 || parsedLimit > 1000) {
      return res.status(400).json({ success: false, message: 'Player limit must be an integer between 2 and 1000' });
    }

    const parsedEntryCost = entryCostCoins === undefined ? 3 : Number(entryCostCoins);
    if (!Number.isInteger(parsedEntryCost) || parsedEntryCost < 0 || parsedEntryCost > 1000) {
      return res.status(400).json({ success: false, message: 'Entry cost must be a whole number between 0 and 1000 coins' });
    }

    const parsedTimer = defaultTimeLimit === undefined ? 15 : Number(defaultTimeLimit);
    if (!Number.isInteger(parsedTimer) || parsedTimer < 5 || parsedTimer > 120) {
      return res.status(400).json({ success: false, message: 'Timer per question must be between 5 and 120 seconds' });
    }

    const qError = validateJackpotQuestions(questions, parsedTimer);
    if (qError) {
      return res.status(400).json({ success: false, message: qError });
    }

    const adminUser = await User.findById(adminId);
    if (!adminUser || (!adminUser.isAdmin && !adminUser.isSuperAdmin)) {
      return res.status(403).json({ success: false, message: 'Admin privileges required' });
    }

    const cleanQuestions = questions.map((q: any) => ({
      question: q.question.trim(),
      options: q.options.map((o: string) => o.trim()),
      correctOption: q.correctOption.trim(),
      timeLimit: q.timeLimit !== undefined ? Math.floor(Number(q.timeLimit)) : parsedTimer
    }));

    // Persist backing Quiz document (unpublished, owned by admin) so existing
    // GameSession.quiz population and host history work seamlessly.
    const quiz = await Quiz.create({
      title: title.trim(),
      description: `Jackpot Room — Prize: ${prizeLabel.trim()}`,
      creator: adminId,
      questions: cleanQuestions,
      price: 0,
      priceCoins: 0,
      isPublishedToMarketplace: false,
      isDefault: false
    });

    const gamePin = await generateUniqueGamePin();
    const randomizedQuestions = buildRandomizedQuestions(cleanQuestions, parsedTimer);

    const session = await GameSession.create({
      gamePin,
      host: adminId,
      quiz: quiz._id,
      state: 'LOBBY',
      currentQuestionIndex: 0,
      backgroundMusic: 'off',
      playerLimit: parsedLimit,
      chatEnabled: true,
      players: [],
      isJackpot: true,
      jackpot: {
        title: title.trim(),
        prizeLabel: prizeLabel.trim(),
        entryCostCoins: parsedEntryCost,
        paidSeatsCount: 0,
        defaultTimeLimit: parsedTimer,
        winners: []
      },
      randomizedQuestions
    });

    const sessionObj: any = session.toObject();
    sessionObj.hostDisplayName = adminUser.displayName;
    await registerActiveRoom(gamePin, sessionObj, quiz);

    const io = req.app.get('socketio');
    emitJackpotLiveUpdate(io);

    return res.status(201).json({
      success: true,
      message: 'Jackpot Room is now LIVE!',
      room: {
        id: String(session._id),
        gamePin,
        title: session.jackpot!.title,
        prizeLabel: session.jackpot!.prizeLabel,
        entryCostCoins: session.jackpot!.entryCostCoins,
        playerLimit: session.playerLimit,
        totalQuestions: randomizedQuestions.length,
        defaultTimeLimit: parsedTimer,
        state: session.state,
        chatEnabled: session.chatEnabled
      }
    });
  } catch (error: any) {
    return sendServerError(res, error, 'adminCreateJackpotRoom');
  }
};

// 5. ADMIN: List all Jackpot rooms (live, finished, cancelled) with Top 5 winners
export const adminListJackpotRooms = async (req: AuthRequest, res: Response) => {
  try {
    const sessions = await GameSession.find({ isJackpot: true })
      .sort({ createdAt: -1 })
      .limit(50);

    const sessionIds = sessions.map((s) => s._id);
    const entryStats = await JackpotEntry.aggregate([
      { $match: { gameSession: { $in: sessionIds } } },
      {
        $group: {
          _id: { gameSession: '$gameSession', status: '$status' },
          count: { $sum: 1 },
          coins: { $sum: '$coinsPaid' }
        }
      }
    ]);

    const statsBySession = new Map<string, { paidCount: number; paidCoins: number; refundedCount: number; refundedCoins: number }>();
    for (const row of entryStats) {
      const sid = String(row._id.gameSession);
      const curr = statsBySession.get(sid) || { paidCount: 0, paidCoins: 0, refundedCount: 0, refundedCoins: 0 };
      if (row._id.status === 'paid') {
        curr.paidCount += row.count;
        curr.paidCoins += row.coins;
      } else if (row._id.status === 'refunded') {
        curr.refundedCount += row.count;
        curr.refundedCoins += row.coins;
      }
      statsBySession.set(sid, curr);
    }

    const rooms = sessions.map((s) => {
      const st = statsBySession.get(String(s._id)) || { paidCount: 0, paidCoins: 0, refundedCount: 0, refundedCoins: 0 };
      return {
        id: String(s._id),
        gamePin: s.gamePin,
        title: s.jackpot?.title || 'Jackpot Room',
        prizeLabel: s.jackpot?.prizeLabel || '',
        entryCostCoins: s.jackpot?.entryCostCoins ?? 3,
        playerLimit: s.playerLimit,
        playersJoined: s.players.length,
        totalQuestions: s.randomizedQuestions?.length || 0,
        defaultTimeLimit: s.jackpot?.defaultTimeLimit ?? 15,
        state: s.state,
        cancelReason: s.jackpot?.cancelReason,
        refundProcessedAt: s.jackpot?.refundProcessedAt,
        paidEntriesCount: st.paidCount,
        totalCoinsCollected: st.paidCoins,
        refundedEntriesCount: st.refundedCount,
        totalCoinsRefunded: st.refundedCoins,
        winners: s.jackpot?.winners || [],
        canViewPayoutContacts: true,
        createdAt: s.createdAt,
        finishedAt: s.finishedAt
      };
    });

    return res.status(200).json({ success: true, rooms });
  } catch (error: any) {
    return sendServerError(res, error, 'adminListJackpotRooms');
  }
};

// 6. ADMIN: Get single Jackpot room details & Top 5 winners payout list
export const adminGetJackpotRoomDetail = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const session = await GameSession.findOne({ _id: id, isJackpot: true });
    if (!session || !session.jackpot) {
      return res.status(404).json({ success: false, message: 'Jackpot Room not found' });
    }

    const entries = await JackpotEntry.find({ gameSession: session._id })
      .populate('user', 'displayName email phone avatarUrl')
      .sort({ paidAt: 1 });

    return res.status(200).json({
      success: true,
      room: {
        id: String(session._id),
        gamePin: session.gamePin,
        title: session.jackpot.title,
        prizeLabel: session.jackpot.prizeLabel,
        entryCostCoins: session.jackpot.entryCostCoins,
        playerLimit: session.playerLimit,
        playersJoined: session.players.length,
        totalQuestions: session.randomizedQuestions?.length || 0,
        defaultTimeLimit: session.jackpot.defaultTimeLimit,
        state: session.state,
        cancelReason: session.jackpot.cancelReason,
        refundProcessedAt: session.jackpot.refundProcessedAt,
        winners: session.jackpot.winners || [],
        canViewPayoutContacts: true,
        createdAt: session.createdAt,
        finishedAt: session.finishedAt,
        entries: entries.map((e: any) => ({
          id: String(e._id),
          userId: e.user?._id ? String(e.user._id) : String(e.user),
          displayName: e.user?.displayName || e.nickname,
          nickname: e.nickname,
          email: e.user?.email || '',
          phone: e.user?.phone || '',
          coinsPaid: e.coinsPaid,
          status: e.status,
          paidAt: e.paidAt,
          refundedAt: e.refundedAt
        }))
      }
    });
  } catch (error: any) {
    return sendServerError(res, error, 'adminGetJackpotRoomDetail');
  }
};

// 7. ADMIN: Cancel a Jackpot room and refund all paid participants automatically
export const adminCancelJackpotRoom = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 200)
      : 'Cancelled by admin';

    const existing = await GameSession.findOne({ _id: id, isJackpot: true });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Jackpot Room not found' });
    }
    if (existing.state === 'FINISHED') {
      return res.status(400).json({ success: false, message: 'Cannot cancel a Jackpot Room that has already finished.' });
    }

    const io = req.app.get('socketio');
    const result = await cancelAndRefundJackpotRoom(io, { sessionId: String(existing._id) }, reason);

    await forceCloseActiveRoom(
      io,
      existing.gamePin,
      'This Jackpot Room was cancelled by the admin. Any entry coins have been automatically refunded to your wallet.'
    );

    return res.status(200).json({
      success: true,
      message: result.refundedCount > 0
        ? `Jackpot Room cancelled. Refunded ${result.totalCoinsRefunded} coins across ${result.refundedCount} player(s).`
        : 'Jackpot Room cancelled.',
      refundedCount: result.refundedCount,
      totalCoinsRefunded: result.totalCoinsRefunded
    });
  } catch (error: any) {
    return sendServerError(res, error, 'adminCancelJackpotRoom');
  }
};
