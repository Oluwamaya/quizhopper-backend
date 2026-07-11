import { Response } from 'express';
import { Quiz } from '../models/Quiz';
import { QuizPurchase } from '../models/QuizPurchase';
import { User } from '../models/User';
import { getGlobalConfig } from '../models/AppConfig';
import { AuthRequest } from '../middlewares/authMiddleware';

// Purchase a quiz (Mock Stripe Payment callback/endpoint)
export const purchaseQuiz = async (req: AuthRequest, res: Response) => {
  try {
    const { quizId } = req.body;
    const buyerId = req.userId;

    if (!quizId) {
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

    // 3. Create the purchase transaction
    const purchase = await QuizPurchase.create({
      buyer: buyerId,
      quiz: quizId,
      pricePaid: quiz.price
    });

    // 4. Distribute earnings dynamically based on the current platform commission config
    if (quiz.creator && quiz.price > 0) {
      const config = await getGlobalConfig();
      const commissionMultiplier = 1 - config.commissionRate; // e.g. 1 - 0.15 = 0.85
      const sellerEarnings = Number((quiz.price * commissionMultiplier).toFixed(2));

      await User.findByIdAndUpdate(quiz.creator, {
        $inc: {
          balance: sellerEarnings,
          salesCount: 1
        }
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Quiz purchased successfully',
      purchase
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

    const config = await getGlobalConfig();
    const commissionMultiplier = 1 - config.commissionRate;

    // Find all quizzes authored by this user
    const sellerQuizzes = await Quiz.find({ creator: userId });
    const quizIds = sellerQuizzes.map(q => q._id);

    // Retrieve all sales transactions for these quizzes
    const salesTransactions = await QuizPurchase.find({ quiz: { $in: quizIds } })
      .populate('buyer', 'displayName email')
      .populate('quiz', 'title price')
      .sort({ createdAt: -1 });

    const formattedSales = salesTransactions.map((sale: any) => {
      const amountEarned = Number((sale.pricePaid * commissionMultiplier).toFixed(2));
      return {
        id: sale._id,
        buyerName: sale.buyer ? sale.buyer.displayName : 'Anonymous',
        buyerEmail: sale.buyer ? sale.buyer.email : '',
        quizTitle: sale.quiz ? sale.quiz.title : 'Deleted Quiz',
        pricePaid: sale.pricePaid,
        earnings: amountEarned,
        date: sale.createdAt
      };
    });

    return res.status(200).json({
      success: true,
      stats: {
        balance: seller.balance,
        salesCount: seller.salesCount,
        publishedQuizzesCount: sellerQuizzes.length
      },
      salesHistory: formattedSales
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

// Process payout withdrawal for a seller
export const withdrawEarnings = async (req: AuthRequest, res: Response) => {
  try {
    const { amount } = req.body;
    const userId = req.userId;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal amount' });
    }

    const seller = await User.findById(userId);
    if (!seller) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (amount > seller.balance) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance
    seller.balance = Number((seller.balance - amount).toFixed(2));
    await seller.save();

    console.log(`WITHDRAWAL PROCESSED: $${amount} paid out to seller ${seller.email}`);

    return res.status(200).json({
      success: true,
      message: `Withdrawal of $${amount.toFixed(2)} processed successfully!`,
      newBalance: seller.balance
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
