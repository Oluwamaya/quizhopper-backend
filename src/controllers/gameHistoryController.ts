import { Response } from 'express';
import { GameSession } from '../models/GameSession';
import { AuthRequest } from '../middlewares/authMiddleware';
import { getGlobalConfig } from '../models/AppConfig';

// Retrieve current platform pricing: hosting capacity costs and the coin exchange rate
export const getHostingPricing = async (req: AuthRequest, res: Response) => {
  try {
    const config = await getGlobalConfig();
    return res.status(200).json({
      success: true,
      pricing: {
        freeTierLimit: config.freeTierLimit,
        extraPlayerCoinCost: config.extraPlayerCoinCost,
        coinPrice: config.coinPrice
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Retrieve completed game sessions hosted by the current user (paginated)
export const getGameHistory = async (req: AuthRequest, res: Response) => {
  try {
    const hostId = req.userId;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    const filter = { host: hostId, state: 'FINISHED' as const };
    const totalCount = await GameSession.countDocuments(filter);

    const sessions = await GameSession.find(filter)
      .populate('quiz', 'title questions')
      .sort({ finishedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const formattedHistory = sessions.map((session: any) => {
      // Sort players by score in descending order
      const rankedPlayers = [...session.players].sort((a, b) => b.score - a.score);

      return {
        id: session._id,
        gamePin: session.gamePin,
        quizTitle: session.quiz ? session.quiz.title : 'Deleted Quiz',
        totalQuestions: session.quiz && session.quiz.questions ? session.quiz.questions.length : 0,
        playerCount: session.players.length,
        players: rankedPlayers.map((player, index) => ({
          rank: index + 1,
          nickname: player.nickname,
          avatar: player.avatar,
          score: player.score
        })),
        createdAt: session.createdAt,
        finishedAt: session.finishedAt
      };
    });

    return res.status(200).json({
      success: true,
      count: formattedHistory.length,
      history: formattedHistory,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit))
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete a single hosted game session from the current user's history
export const deleteGameHistory = async (req: AuthRequest, res: Response) => {
  try {
    const hostId = req.userId;
    const { id } = req.params;

    const session = await GameSession.findById(id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session history entry not found' });
    }

    if (session.host.toString() !== hostId) {
      return res.status(403).json({ success: false, message: 'Access Denied: You are not the host of this session' });
    }

    if (session.state !== 'FINISHED') {
      return res.status(400).json({ success: false, message: 'Only finished sessions can be removed from history' });
    }

    await GameSession.findByIdAndDelete(id);
    return res.status(200).json({ success: true, message: 'Session removed from history' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
