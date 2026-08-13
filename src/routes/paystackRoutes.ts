import { Router } from 'express';
import { 
  initializePaystackDeposit, 
  verifyPaystackDeposit, 
  handlePaystackWebhook,
  getWalletTransactions
} from '../controllers/paystackController';
import { protect } from '../middlewares/authMiddleware';
import { paystackLimiter } from '../middlewares/rateLimiters';

const router = Router();

// Wallet Top-up Endpoints
router.post('/initialize', protect, paystackLimiter, initializePaystackDeposit);
router.get('/verify/:reference', protect, paystackLimiter, verifyPaystackDeposit);
router.post('/webhook', handlePaystackWebhook);
router.get('/transactions', protect, getWalletTransactions);

export default router;
