import { Router } from 'express';
import { getGameHistory, getHostingPricing, deleteGameHistory } from '../controllers/gameHistoryController';
import { protect } from '../middlewares/authMiddleware';

const router = Router();

// Retrieve game session host history
router.get('/history', protect, getGameHistory);

// Delete a single hosted session from history
router.delete('/history/:id', protect, deleteGameHistory);

// Retrieve current hosting capacity pricing (free tier + per-player coin cost)
router.get('/pricing', protect, getHostingPricing);

export default router;
