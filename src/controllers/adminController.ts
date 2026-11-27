import { Response } from 'express';
import { User } from '../models/User';
import { Quiz } from '../models/Quiz';
import { QuizPurchase } from '../models/QuizPurchase';
import { GameSession } from '../models/GameSession';
import { JackpotEntry } from '../models/JackpotEntry';
import { WalletTransaction } from '../models/WalletTransaction';
import { getGlobalConfig } from '../models/AppConfig';
import { AuthRequest } from '../middlewares/authMiddleware';
import { sendServerError } from '../middlewares/errorHandler';
import { emitWalletUpdate } from '../utils/adminEvents';

// Escape regex metacharacters so user search input is always treated as a
// literal substring — an unescaped pattern could both cause a NoSQL/ReDoS
// style catastrophic-backtracking match and behave unexpectedly for users
// who type things like "." or "(".
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Retrieve global system configuration (commission rate, player limit)
export const getAdminConfig = async (req: AuthRequest, res: Response) => {
  try {
    const config = await getGlobalConfig();
    return res.status(200).json({ success: true, config });
  } catch (error: any) {
    return sendServerError(res, error, 'getAdminConfig');
  }
};

// Update global system configuration (commission rate, player limit)
export const updateAdminConfig = async (req: AuthRequest, res: Response) => {
  try {
    const { freeTierLimit, extraPlayerCoinCost, coinPrice, quizPriceCoins, signupCoinGift, aiGenerationCoinCost } = req.body;
    const config = await getGlobalConfig();

    if (freeTierLimit !== undefined) {
      if (freeTierLimit < 2 || freeTierLimit > 1000) {
        return res.status(400).json({ success: false, message: 'Free-tier player limit must be between 2 and 1000' });
      }
      config.freeTierLimit = freeTierLimit;
    }

    if (extraPlayerCoinCost !== undefined) {
      if (extraPlayerCoinCost < 0) {
        return res.status(400).json({ success: false, message: 'Extra player coin cost must be 0 or greater' });
      }
      config.extraPlayerCoinCost = extraPlayerCoinCost;
    }

    if (coinPrice !== undefined) {
      if (coinPrice <= 0) {
        return res.status(400).json({ success: false, message: 'Coin exchange rate must be greater than 0' });
      }
      config.coinPrice = coinPrice;
    }

    if (quizPriceCoins !== undefined) {
      if (quizPriceCoins < 0 || quizPriceCoins > 10) {
        return res.status(400).json({ success: false, message: 'Default quiz price must be between 0 and 10 coins' });
      }
      config.quizPriceCoins = quizPriceCoins;
    }

    if (signupCoinGift !== undefined) {
      if (signupCoinGift < 0 || signupCoinGift > 1000) {
        return res.status(400).json({ success: false, message: 'Signup coin gift must be between 0 and 1000' });
      }
      config.signupCoinGift = signupCoinGift;
    }

    if (aiGenerationCoinCost !== undefined) {
      if (aiGenerationCoinCost < 0 || aiGenerationCoinCost > 1000) {
        return res.status(400).json({ success: false, message: 'AI generation coin cost must be between 0 and 1000' });
      }
      config.aiGenerationCoinCost = aiGenerationCoinCost;
    }

    config.updatedAt = new Date();
    await config.save();

    return res.status(200).json({ success: true, message: 'Settings updated successfully', config });
  } catch (error: any) {
    return sendServerError(res, error, 'updateAdminConfig');
  }
};

// Retrieve overall platform statistics + separated Normal Gameplay vs Jackpot Wallet accounting (Super Admin only)
export const getPlatformStats = async (req: AuthRequest, res: Response) => {
  try {
    const config = await getGlobalConfig();
    const coinPrice = config.coinPrice || 200;

    const [
      totalUsers,
      totalQuizzes,
      totalPurchases,
      purchases,
      activeSessions,
      totalFinishedGames,
      normalActiveRooms,
      normalFinishedGames,
      jackpotLiveRooms,
      jackpotFinishedRooms,
      jackpotCancelledRooms,
      totalJackpotPaidEntries,
      coinsAgg,
      depositAgg,
      txnBreakdown
    ] = await Promise.all([
      User.countDocuments(),
      Quiz.countDocuments({ isDefault: false }),
      QuizPurchase.countDocuments(),
      QuizPurchase.find().select('pricePaid'),
      GameSession.countDocuments({ state: { $nin: ['FINISHED', 'CANCELLED'] } }),
      GameSession.countDocuments({ state: 'FINISHED' }),
      GameSession.countDocuments({ isJackpot: { $ne: true }, state: { $nin: ['FINISHED', 'CANCELLED'] } }),
      GameSession.countDocuments({ isJackpot: { $ne: true }, state: 'FINISHED' }),
      GameSession.countDocuments({ isJackpot: true, state: { $in: ['LOBBY', 'QUESTION_ACTIVE', 'SCOREBOARD'] } }),
      GameSession.countDocuments({ isJackpot: true, state: 'FINISHED' }),
      GameSession.countDocuments({ isJackpot: true, state: 'CANCELLED' }),
      JackpotEntry.countDocuments({ status: 'paid' }),
      WalletTransaction.aggregate([
        { $match: { coinsChange: { $gt: 0 }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$coinsChange' } } }
      ]),
      WalletTransaction.aggregate([
        { $match: { type: 'deposit', status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amountMoney' } } }
      ]),
      WalletTransaction.aggregate([
        { $match: { status: 'completed' } },
        {
          $group: {
            _id: '$type',
            totalCoins: { $sum: '$coinsChange' },
            totalMoney: { $sum: '$amountMoney' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const byType = new Map<string, { totalCoins: number; totalMoney: number; count: number }>();
    for (const row of txnBreakdown) {
      byType.set(row._id, {
        totalCoins: row.totalCoins || 0,
        totalMoney: row.totalMoney || 0,
        count: row.count || 0
      });
    }

    const totalVolumeCoins = purchases.reduce((acc, curr) => acc + curr.pricePaid, 0);
    const totalCoinsAccumulated = coinsAgg.length > 0 ? coinsAgg[0].total : 0;
    const totalMoneyDeposited = depositAgg.length > 0 ? depositAgg[0].total : 0;

    // Separated Normal Gameplay Wallet calculations
    const hostingCoinsSpent = Math.abs(byType.get('host_game')?.totalCoins || 0);
    const aiCoinsSpent = Math.abs(byType.get('ai_quiz_generation')?.totalCoins || 0);
    const totalNormalCoinsSpent = hostingCoinsSpent + aiCoinsSpent;
    const totalCoinsPurchased = byType.get('buy_coins')?.totalCoins || 0;
    const signupBonusCoins = byType.get('signup_bonus')?.totalCoins || 0;

    // Separated Jackpot Wallet calculations
    const jackpotGrossCoins = Math.abs(byType.get('jackpot_entry')?.totalCoins || 0);
    const jackpotRefundedCoins = Math.abs(byType.get('jackpot_refund')?.totalCoins || 0);
    const jackpotNetCoins = Math.max(0, jackpotGrossCoins - jackpotRefundedCoins);

    return res.status(200).json({
      success: true,
      stats: {
        coinPrice,
        totalUsers,
        totalQuizzes,
        totalPurchases,
        totalVolumeCoins,
        activeSessions,
        totalFinishedGames,
        totalCoinsAccumulated,
        totalMoneyDeposited,
        wallets: {
          normal: {
            hostingCoinsSpent,
            hostingNairaValue: hostingCoinsSpent * coinPrice,
            aiCoinsSpent,
            aiNairaValue: aiCoinsSpent * coinPrice,
            totalCoinsSpent: totalNormalCoinsSpent,
            totalNairaValue: totalNormalCoinsSpent * coinPrice,
            totalPaystackDepositsNaira: totalMoneyDeposited,
            totalCoinsPurchased,
            signupBonusCoins,
            activeRooms: normalActiveRooms,
            finishedGames: normalFinishedGames
          },
          jackpot: {
            grossCoinsCollected: jackpotGrossCoins,
            grossNairaValue: jackpotGrossCoins * coinPrice,
            refundedCoins: jackpotRefundedCoins,
            refundedNairaValue: jackpotRefundedCoins * coinPrice,
            netCoinsCollected: jackpotNetCoins,
            netNairaValue: jackpotNetCoins * coinPrice,
            liveRooms: jackpotLiveRooms,
            finishedRooms: jackpotFinishedRooms,
            cancelledRooms: jackpotCancelledRooms,
            totalPaidEntries: totalJackpotPaidEntries
          }
        }
      }
    });
  } catch (error: any) {
    return sendServerError(res, error, 'getPlatformStats');
  }
};

// Retrieve users list with search filter
export const getPlatformUsers = async (req: AuthRequest, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    let query = {};

    if (search) {
      const safePattern = escapeRegex(search);
      query = {
        $or: [
          { displayName: { $regex: safePattern, $options: 'i' } },
          { email: { $regex: safePattern, $options: 'i' } }
        ]
      };
    }

    const users = await User.find(query).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, count: users.length, users });
  } catch (error: any) {
    return sendServerError(res, error, 'getPlatformUsers');
  }
};

// Retrieve detailed activity history for a single user (created quizzes, purchases)
export const getPlatformUserDetail = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Quizzes created by this user
    const quizzesCreated = await Quiz.find({ creator: id, isDefault: false }).sort({ createdAt: -1 });

    // Quizzes purchased by this user
    const purchases = await QuizPurchase.find({ buyer: id })
      .populate('quiz', 'title price')
      .sort({ createdAt: -1 });

    const formattedPurchases = purchases.map((p: any) => ({
      id: p._id,
      quizTitle: p.quiz ? p.quiz.title : 'Deleted Quiz',
      pricePaid: p.pricePaid,
      date: p.createdAt
    }));

    return res.status(200).json({
      success: true,
      userDetail: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone || '',
        isPremium: user.isPremium,
        isAdmin: Boolean(user.isAdmin || user.isSuperAdmin),
        isSuperAdmin: Boolean(user.isSuperAdmin),
        balance: user.balance,
        coins: user.coins,
        salesCount: user.salesCount,
        createdAt: user.createdAt,
        quizzesCreated,
        purchases: formattedPurchases
      }
    });
  } catch (error: any) {
    return sendServerError(res, error, 'getPlatformUserDetail');
  }
};

// Modify user flags (grant Premium, Toggle Admin / Super Admin, adjust balance/coins)
export const updateUserStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { targetUserId, isPremium, isAdmin, isSuperAdmin, balance, coins } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Target User ID is required' });
    }

    if (targetUserId === req.userId && (isAdmin === false || isSuperAdmin === false)) {
      return res.status(400).json({ success: false, message: 'You cannot revoke your own Super Admin rights' });
    }

    const updateFields: any = {};
    if (isPremium !== undefined) updateFields.isPremium = !!isPremium;
    if (isAdmin !== undefined) {
      updateFields.isAdmin = !!isAdmin;
      // Demoting from Admin also revokes Super Admin
      if (!isAdmin) updateFields.isSuperAdmin = false;
    }
    if (isSuperAdmin !== undefined) {
      updateFields.isSuperAdmin = !!isSuperAdmin;
      // Promoting to Super Admin always grants Admin capabilities too
      if (isSuperAdmin) updateFields.isAdmin = true;
    }
    if (balance !== undefined) {
      const numericBalance = Number(balance);
      if (!Number.isFinite(numericBalance) || numericBalance < 0) {
        return res.status(400).json({ success: false, message: 'Balance must be a non-negative number' });
      }
      updateFields.balance = numericBalance;
    }
    if (coins !== undefined) {
      const numericCoins = Number(coins);
      if (!Number.isFinite(numericCoins) || numericCoins < 0) {
        return res.status(400).json({ success: false, message: 'Coins must be a non-negative number' });
      }
      updateFields.coins = numericCoins;
    }

    const user = await User.findByIdAndUpdate(targetUserId, updateFields, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Target user not found' });
    }

    // The admin is the one making this request, not the affected user —
    // without this push, someone whose balance/coins an admin just changed
    // wouldn't see it update until their next unrelated refresh.
    if (balance !== undefined || coins !== undefined) {
      emitWalletUpdate(req.app.get('socketio'), String(user._id), { coins: user.coins, balance: user.balance });
    }

    return res.status(200).json({ success: true, message: 'User updated successfully', user });
  } catch (error: any) {
    return sendServerError(res, error, 'updateUserStatus');
  }
};

// Broadcast an alert popup to all connected sockets
export const broadcastAnnouncement = async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Announcement message cannot be empty' });
    }
    if (message.length > 500) {
      return res.status(400).json({ success: false, message: 'Announcement message must be under 500 characters' });
    }

    const io = req.app.get('socketio');
    if (!io) {
      return res.status(500).json({ success: false, message: 'Socket server instance not active' });
    }

    io.emit('system_announcement', {
      message: message.trim(),
      date: new Date()
    });

    return res.status(200).json({ success: true, message: 'Broadcast announcement dispatched successfully' });
  } catch (error: any) {
    return sendServerError(res, error, 'broadcastAnnouncement');
  }
};

// Retrieve every wallet transaction platform-wide (coin purchases, Paystack
// deposits, marketplace sales, etc.), paginated, newest first, with the
// owning user's identity attached so the admin can see who did what.
export const getAllTransactions = async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10));
    const typeFilter = typeof req.query.type === 'string' && req.query.type !== 'all' ? req.query.type : undefined;
    const categoryFilter = typeof req.query.category === 'string' ? req.query.category : 'all';

    const filter: any = {};
    if (!req.isSuperAdmin) {
      // Jackpot Admins only see Jackpot transactions (entries & refunds), never
      // users' private Paystack deposits or normal hosting history.
      if (typeFilter === 'jackpot_entry' || typeFilter === 'jackpot_refund') {
        filter.type = typeFilter;
      } else {
        filter.type = { $in: ['jackpot_entry', 'jackpot_refund'] };
      }
    } else if (typeFilter) {
      filter.type = typeFilter;
    } else if (categoryFilter === 'jackpot') {
      filter.type = { $in: ['jackpot_entry', 'jackpot_refund'] };
    } else if (categoryFilter === 'normal') {
      filter.type = { $nin: ['jackpot_entry', 'jackpot_refund'] };
    }

    const totalCount = await WalletTransaction.countDocuments(filter);

    const transactions = await WalletTransaction.find(filter)
      .populate('user', 'displayName email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      success: true,
      transactions,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit))
    });
  } catch (error: any) {
    return sendServerError(res, error, 'getAllTransactions');
  }
};
