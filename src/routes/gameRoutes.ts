import { Router } from 'express';
import { getGameHistory } from '../controllers/gameHistoryController';
import { protect } from '../middlewares/authMiddleware';

const router = Router();

// Retrieve game session host history
router.get('/history', protect, getGameHistory);

export default router;
