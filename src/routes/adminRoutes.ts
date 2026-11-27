import { Router } from 'express';
import {
  getAdminConfig,
  updateAdminConfig,
  getPlatformStats,
  getPlatformUsers,
  getPlatformUserDetail,
  updateUserStatus,
  broadcastAnnouncement,
  getAllTransactions
} from '../controllers/adminController';
import { protect } from '../middlewares/authMiddleware';
import { adminProtect, superAdminProtect } from '../middlewares/adminMiddleware';

const router = Router();

// All admin routes require authentication
router.use(protect);

// Allowed for both Jackpot Admins and Super Admins
router.get('/config', adminProtect, getAdminConfig);
// Transactions: Super Admin sees all; Jackpot Admin is strictly scoped to jackpot_entry/jackpot_refund in controller
router.get('/transactions', adminProtect, getAllTransactions);

// Everything below is strictly Super Admin only (main engine control room)
router.use(superAdminProtect);

router.post('/config', updateAdminConfig);
router.get('/stats', getPlatformStats);
router.get('/users', getPlatformUsers);
router.get('/user/:id', getPlatformUserDetail);
router.post('/user/update', updateUserStatus);
router.post('/broadcast', broadcastAnnouncement);

export default router;
