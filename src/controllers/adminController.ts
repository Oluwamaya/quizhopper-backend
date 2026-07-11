import { Response } from 'express';
import { User } from '../models/User';
import { Quiz } from '../models/Quiz';
import { QuizPurchase } from '../models/QuizPurchase';
import { GameSession } from '../models/GameSession';
import { getGlobalConfig } from '../models/AppConfig';
import { AuthRequest } from '../middlewares/authMiddleware';

// Retrieve global system configuration (commission rate, player limit)
export const getAdminConfig = async (req: AuthRequest, res: Response) => {
  try {
    const config = await getGlobalConfig();
    return res.status(200).json({ success: true, config });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update global system configuration (commission rate, player limit)
export const updateAdminConfig = async (req: AuthRequest, res: Response) => {
  try {
    const { commissionRate, freeTierLimit, coinPrice } = req.body;
    const config = await getGlobalConfig();

    if (commissionRate !== undefined) {
      if (commissionRate < 0 || commissionRate > 0.9) {
        return res.status(400).json({ success: false, message: 'Commission rate must be between 0% and 90% (0.0 to 0.9)' });
      }
      config.commissionRate = commissionRate;
    }

    if (freeTierLimit !== undefined) {
      if (freeTierLimit < 2 || freeTierLimit > 1000) {
        return res.status(400).json({ success: false, message: 'Free-tier player limit must be between 2 and 1000' });
      }
      config.freeTierLimit = freeTierLimit;
    }

    if (coinPrice !== undefined) {
      if (coinPrice <= 0) {
        return res.status(400).json({ success: false, message: 'Coin exchange rate must be greater than $0.00' });
      }
      config.coinPrice = coinPrice;
    }

    config.updatedAt = new Date();
    await config.save();

    return res.status(200).json({ success: true, message: 'Settings updated successfully', config });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Retrieve overall platform statistics and revenue
export const getPlatformStats = async (req: AuthRequest, res: Response) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalQuizzes = await Quiz.countDocuments({ isDefault: false });
    const totalPurchases = await QuizPurchase.countDocuments();
    
    const purchases = await QuizPurchase.find();
    const config = await getGlobalConfig();
    
    const totalVolume = purchases.reduce((acc, curr) => acc + curr.pricePaid, 0);
    const platformEarnings = purchases.reduce((acc, curr) => acc + (curr.pricePaid * config.commissionRate), 0);

    const activeSessions = await GameSession.countDocuments({ state: { $ne: 'FINISHED' } });
    const totalFinishedGames = await GameSession.countDocuments({ state: 'FINISHED' });

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        totalQuizzes,
        totalPurchases,
        totalVolume: Number(totalVolume.toFixed(2)),
        platformEarnings: Number(platformEarnings.toFixed(2)),
        activeSessions,
        totalFinishedGames
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Retrieve users list with search filter
export const getPlatformUsers = async (req: AuthRequest, res: Response) => {
  try {
    const search = req.query.search as string;
    let query = {};
    
    if (search) {
      query = {
        $or: [
          { displayName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
    }

    const users = await User.find(query).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, count: users.length, users });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
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
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        salesCount: user.salesCount,
        createdAt: user.createdAt,
        quizzesCreated,
        purchases: formattedPurchases
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Modify user flags (grant Premium, Toggle Admin, adjust balance)
export const updateUserStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { targetUserId, isPremium, isAdmin, balance } = req.body;
    
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Target User ID is required' });
    }

    if (targetUserId === req.userId && isAdmin === false) {
      return res.status(400).json({ success: false, message: 'You cannot revoke your own admin rights' });
    }

    const updateFields: any = {};
    if (isPremium !== undefined) updateFields.isPremium = !!isPremium;
    if (isAdmin !== undefined) updateFields.isAdmin = !!isAdmin;
    if (balance !== undefined) updateFields.balance = Number(balance);

    const user = await User.findByIdAndUpdate(targetUserId, updateFields, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Target user not found' });
    }

    return res.status(200).json({ success: true, message: 'User updated successfully', user });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Broadcast an alert popup to all connected sockets
export const broadcastAnnouncement = async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Announcement message cannot be empty' });
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
    return res.status(500).json({ success: false, message: error.message });
  }
};
