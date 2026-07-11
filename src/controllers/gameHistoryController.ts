import { Response } from 'express';
import { GameSession } from '../models/GameSession';
import { AuthRequest } from '../middlewares/authMiddleware';

// Retrieve all completed game sessions hosted by the current user
export const getGameHistory = async (req: AuthRequest, res: Response) => {
  try {
    const hostId = req.userId;

    const sessions = await GameSession.find({
      host: hostId,
      state: 'FINISHED'
    })
      .populate('quiz', 'title questions')
      .sort({ finishedAt: -1 });

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

    return res.status(200).json({ success: true, count: formattedHistory.length, history: formattedHistory });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
