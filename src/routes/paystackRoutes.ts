import { Router } from 'express';
import { 
  initializePaystackDeposit, 
  verifyPaystackDeposit, 
  handlePaystackWebhook,
  getWalletTransactions
} from '../controllers/paystackController';
import { protect } from '../middlewares/authMiddleware';

const router = Router();

// Wallet Top-up Endpoints
router.post('/initialize', protect, initializePaystackDeposit);
router.get('/verify/:reference', protect, verifyPaystackDeposit);
router.post('/webhook', handlePaystackWebhook);
router.get('/transactions', protect, getWalletTransactions);

export default router;
