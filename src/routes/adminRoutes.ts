import { Router } from 'express';
import { 
  getAdminConfig, 
  updateAdminConfig, 
  getPlatformStats, 
  getPlatformUsers, 
  getPlatformUserDetail,
  updateUserStatus, 
  broadcastAnnouncement 
} from '../controllers/adminController';
import { protect } from '../middlewares/authMiddleware';
import { adminProtect } from '../middlewares/adminMiddleware';

const router = Router();

// Apply auth and admin protections globally on these routes
router.use(protect, adminProtect);

// Config endpoints
router.get('/config', getAdminConfig);
router.post('/config', updateAdminConfig);

// Stats analytics endpoint
router.get('/stats', getPlatformStats);

// User lists and account manager endpoints
router.get('/users', getPlatformUsers);
router.get('/user/:id', getPlatformUserDetail);
router.post('/user/update', updateUserStatus);

// System-wide socket announcement endpoint
router.post('/broadcast', broadcastAnnouncement);

export default router;
