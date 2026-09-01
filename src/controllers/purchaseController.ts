import { Response } from 'express';
import { Quiz } from '../models/Quiz';
import { QuizPurchase } from '../models/QuizPurchase';
import { User } from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import { getGlobalConfig } from '../models/AppConfig';
import { AuthRequest } from '../middlewares/authMiddleware';
import { emitAdminTransaction } from '../utils/adminEvents';

// Purchase a quiz using Coins
export const purchaseQuiz = async (req: AuthRequest, res: Response) => {
  try {
    const { quizId } = req.body;
    const buyerId = req.userId;

    if (!quizId || typeof quizId !== 'string') {
      return res.status(400).json({ success: false, message: 'Quiz ID is required' });
    }

    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }

    // 1. Check if user is trying to purchase their own quiz
    if (quiz.creator && quiz.creator.toString() === buyerId) {
      return res.status(400).json({ success: false, message: 'You cannot purchase your own quiz' });
    }

    // 2. Check if already purchased
    const existingPurchase = await QuizPurchase.findOne({ buyer: buyerId, quiz: quizId });
    if (existingPurchase) {
      return res.status(400).json({ success: false, message: 'You have already purchased this quiz' });
    }

    const config = await getGlobalConfig();
    const costInCoins = quiz.priceCoins > 0 ? quiz.priceCoins : (config.quizPriceCoins || 5);

    // Atomic conditional deduction — requiring coins >= cost in the update
    // filter makes the balance-check-and-deduct a single atomic operation,
    // so two concurrent purchase clicks can't both pass a stale balance
    // check and double-spend the same coins.
    const buyer = await User.findOneAndUpdate(
      { _id: buyerId, coins: { $gte: costInCoins } },
      { $inc: { coins: -costInCoins } },
      { new: true }
    );

    if (!buyer) {
      const buyerExists = await User.findById(buyerId).select('coins');
      if (!buyerExists) {
        return res.status(404).json({ success: false, message: 'Buyer user account not found' });
      }
      return res.status(400).json({
        success: false,
        message: `Insufficient coins. You need ${costInCoins} coins to unlock this quiz. Current coins: ${buyerExists.coins}`
      });
    }

    // 3. Create the purchase transaction. `buyer + quiz` has a unique index,
    // so if a concurrent request already recorded this purchase, this
    // throws — refund the coins we just deducted rather than charging twice.
    let purchase;
    try {
      purchase = await QuizPurchase.create({
        buyer: buyerId,
        quiz: quizId,
        pricePaid: costInCoins
      });
    } catch (err: any) {
      if (err.code === 11000) {
        await User.findByIdAndUpdate(buyerId, { $inc: { coins: costInCoins } });
        return res.status(400).json({ success: false, message: 'You have already purchased this quiz' });
      }
      throw err;
    }

    const io = req.app.get('socketio');

    // Log buyer coin deduction
    const buyerTxn = await WalletTransaction.create({
      user: buyerId,
      type: 'marketplace_buy',
      coinsChange: -costInCoins,
      amountMoney: 0,
      description: `Unlocked quiz deck "${quiz.title}"`,
      status: 'completed'
    });
    emitAdminTransaction(io, buyerTxn);

    // 4. Distribute seller coin earnings — the seller keeps 100% of the
    // coin price; the platform takes no cut on marketplace quiz sales.
    if (quiz.creator) {
      const sellerEarn = costInCoins;
      await User.findByIdAndUpdate(quiz.creator, {
        $inc: {
          coins: sellerEarn,
          salesCount: 1
        }
      });
      const sellerTxn = await WalletTransaction.create({
        user: quiz.creator,
        type: 'marketplace_sale',
        coinsChange: sellerEarn,
        amountMoney: 0,
        description: `Marketplace sale credit for "${quiz.title}"`,
        status: 'completed'
      });
      emitAdminTransaction(io, sellerTxn);
    }

    return res.status(201).json({
      success: true,
      message: 'Quiz unlocked successfully!',
      purchase,
      remainingCoins: buyer.coins
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Retrieve Seller Dashboard statistics & transaction histories
export const getSellerDashboard = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;

    const seller = await User.findById(userId);
    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    // Find all quizzes authored by this user
    const sellerQuizzes = await Quiz.find({ creator: userId });
    const quizIds = sellerQuizzes.map(q => q._id);

    const totalCount = await QuizPurchase.countDocuments({ quiz: { $in: quizIds } });

    // Lifetime coins earned from sales — computed from the actual purchase
    // records (sellers keep 100% of pricePaid), not from the live coins
    // balance. The balance also moves from hosting spend, quiz purchases,
    // and deposits, so it can't double as an "earnings" figure — this sum
    // only ever grows, matching what's shown in the sales history below.
    const earningsAgg = await QuizPurchase.aggregate([
      { $match: { quiz: { $in: quizIds } } },
      { $group: { _id: null, total: { $sum: '$pricePaid' } } }
    ]);
    const totalCoinsEarned = earningsAgg.length > 0 ? earningsAgg[0].total : 0;

    // Retrieve a page of sales transactions for these quizzes
    const salesTransactions = await QuizPurchase.find({ quiz: { $in: quizIds } })
      .populate('buyer', 'displayName email')
      .populate('quiz', 'title')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Sellers keep 100% of the coin price on every sale — no platform cut.
    const formattedSales = salesTransactions.map((sale: any) => ({
      id: sale._id,
      buyerName: sale.buyer ? sale.buyer.displayName : 'Anonymous',
      buyerEmail: sale.buyer ? sale.buyer.email : '',
      quizTitle: sale.quiz ? sale.quiz.title : 'Deleted Quiz',
      pricePaid: sale.pricePaid,
      earnings: sale.pricePaid,
      date: sale.createdAt
    }));

    return res.status(200).json({
      success: true,
      stats: {
        totalCoinsEarned,
        salesCount: seller.salesCount,
        publishedQuizzesCount: sellerQuizzes.length
      },
      salesHistory: formattedSales,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit))
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Retrieve user's buying/purchased transaction history
export const getPurchaseHistory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;

    const purchases = await QuizPurchase.find({ buyer: userId })
      .populate({
        path: 'quiz',
        populate: { path: 'creator', select: 'displayName' }
      })
      .sort({ createdAt: -1 });

    const history = purchases.map((p: any) => ({
      id: p._id,
      quizId: p.quiz ? p.quiz._id : null,
      quizTitle: p.quiz ? p.quiz.title : 'Deleted Quiz',
      creatorName: p.quiz && p.quiz.creator ? p.quiz.creator.displayName : 'System',
      pricePaid: p.pricePaid,
      purchaseDate: p.createdAt
    }));

    return res.status(200).json({ success: true, count: history.length, history });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
