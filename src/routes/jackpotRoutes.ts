import { Router } from 'express';
import {
  getLiveJackpotRooms,
  joinJackpotRoom,
  adminGenerateJackpotQuestions,
  adminCreateJackpotRoom,
  adminListJackpotRooms,
  adminGetJackpotRoomDetail,
  adminCancelJackpotRoom
} from '../controllers/jackpotController';
import { optionalAuth, protect } from '../middlewares/authMiddleware';
import { adminProtect } from '../middlewares/adminMiddleware';
import { aiGenerationLimiter } from '../middlewares/rateLimiters';

const router = Router();

// Player / public live card
router.get('/live', optionalAuth, getLiveJackpotRooms);
router.post('/:id/join', protect, joinJackpotRoom);

// Admin-only Jackpot management
router.post('/admin/generate-ai', protect, adminProtect, aiGenerationLimiter, adminGenerateJackpotQuestions);
router.post('/admin/create', protect, adminProtect, adminCreateJackpotRoom);
router.get('/admin/rooms', protect, adminProtect, adminListJackpotRooms);
router.get('/admin/rooms/:id', protect, adminProtect, adminGetJackpotRoomDetail);
router.post('/admin/rooms/:id/cancel', protect, adminProtect, adminCancelJackpotRoom);

export default router;
