import { Router } from 'express';
import passport from 'passport';
import { 
  googleSuccess, 
  devLogin, 
  getMe, 
  logout, 
  subscribePush, 
  getVapidKey,
  register,
  login,
  adminLogin,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  buyCoins
} from '../controllers/authController';
import { protect } from '../middlewares/authMiddleware';
import { authLimiter } from '../middlewares/rateLimiters';

const router = Router();

// Standard Auth Mappings
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);

// Isolated Admin Login Mapping
router.post('/admin-login', authLimiter, adminLogin);

// Password Self-Service Mappings (No auth required)
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);

// Profile & Password Update Mappings (Protected)
router.post('/profile/update', protect, updateProfile);
router.post('/profile/change-password', protect, changePassword);
router.post('/buy-coins', protect, buyCoins);

// Google OAuth login start
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=auth_failed' }),
  googleSuccess
);

// Mock login for developer testing (controller itself 404s in production)
router.post('/dev-login', authLimiter, devLogin);

// Get public VAPID key
router.get('/vapid-key', getVapidKey);

// Current user profile check
router.get('/me', protect, getMe);

// Register web push notifications
router.post('/subscribe', protect, subscribePush);

// Logout
router.post('/logout', protect, logout);

export default router;
