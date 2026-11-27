import { Router } from 'express';
import {
  purchaseQuiz,
  getSellerDashboard,
  getPurchaseHistory
} from '../controllers/purchaseController';
import { protect } from '../middlewares/authMiddleware';

const router = Router();

// Soft-disabled while Jackpot Rooms are the primary earning flow.
// Flip to `true` to re-enable Marketplace & Seller Dashboard endpoints.
const MARKETPLACE_ENABLED = false;

router.use((_req, res, next) => {
  if (!MARKETPLACE_ENABLED) {
    return res.status(404).json({ success: false, message: 'Quiz Marketplace is currently unavailable' });
  }
  next();
});

// Purchase a quiz (Mock Checkout)
router.post('/', protect, purchaseQuiz);

// Get Seller Dashboard stats and transaction history
router.get('/seller/dashboard', protect, getSellerDashboard);

// Get User's buyer purchase history
router.get('/history', protect, getPurchaseHistory);

export default router;
