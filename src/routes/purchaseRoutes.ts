import { Router } from 'express';
import {
  purchaseQuiz,
  getSellerDashboard,
  getPurchaseHistory
} from '../controllers/purchaseController';
import { protect } from '../middlewares/authMiddleware';

const router = Router();

// Purchase a quiz (Mock Checkout)
router.post('/', protect, purchaseQuiz);

// Get Seller Dashboard stats and transaction history
router.get('/seller/dashboard', protect, getSellerDashboard);

// Get User's buyer purchase history
router.get('/history', protect, getPurchaseHistory);

export default router;
