import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User } from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import { getGlobalConfig } from '../models/AppConfig';
import { registerSubscription } from '../services/pushService';
import { AuthRequest } from '../middlewares/authMiddleware';
import { env } from '../config/env';

const JWT_SECRET = env.JWT_SECRET;
const CLIENT_URL = env.CLIENT_URL;

// Minimum acceptable password strength for new/changed passwords
const isPasswordStrongEnough = (password: string): boolean => {
  return typeof password === 'string' && password.length >= 8;
};

// Transient memory-store for mock password reset tokens
// Key: resetToken, Value: { email, expires }
const resetTokensStore = new Map<string, { email: string; expires: number }>();

// Helper to generate and set JWT token
const sendTokenResponse = (user: any, statusCode: number, res: Response) => {
  const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, {
    expiresIn: '30d'
  });

  const cookieOptions = {
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax' as const
  };

  res.cookie('token', token, cookieOptions);
  return token;
};

// 1. Standard Email & Password Registration
export const register = async (req: Request, res: Response) => {
  try {
    const { displayName, email, password } = req.body;
    if (!displayName || !email || !password) {
      return res.status(400).json({ success: false, message: 'Display name, email, and password are required' });
    }

    if (typeof displayName !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid input format' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!isPasswordStrongEnough(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    if (displayName.trim().length < 2 || displayName.trim().length > 32) {
      return res.status(400).json({ success: false, message: 'Display name must be between 2 and 32 characters' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if displayName (username) is unique
    const usernameTaken = await User.findOne({ displayName: displayName.trim() });
    if (usernameTaken) {
      return res.status(400).json({ success: false, message: 'Username (Display name) is already taken' });
    }

    // Check if email already registered
    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ success: false, message: 'Email address is already in use' });
    }

    // Encrypt password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const isFirstUser = (await User.countDocuments()) === 0;

    const user = await User.create({
      displayName: displayName.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      avatarUrl: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(displayName)}`,
      isAdmin: isFirstUser,
      isPremium: false,
      balance: 0,
      salesCount: 0
    });

    const token = sendTokenResponse(user, 201, res);

    return res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 2. Standard User Login (Checks email + password)
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password');
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = sendTokenResponse(user, 200, res);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Isolated Admin Login Gate
export const adminLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password');
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid administrator credentials' });
    }

    if (!user.isAdmin) {
      return res.status(403).json({ success: false, message: 'Access Denied: Invalid administrator credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid administrator credentials' });
    }

    const token = sendTokenResponse(user, 200, res);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 4. Update Profile (DisplayName/Username change unique check)
export const updateProfile = async (req: AuthRequest, res: Response) => {
  try {
    const { displayName } = req.body;
    const userId = req.userId;

    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ success: false, message: 'Display name cannot be empty' });
    }

    const trimmedName = displayName.trim();

    if (trimmedName.length < 2 || trimmedName.length > 32) {
      return res.status(400).json({ success: false, message: 'Display name must be between 2 and 32 characters' });
    }

    // Check if the username is already taken by another user
    const usernameTaken = await User.findOne({ 
      displayName: trimmedName,
      _id: { $ne: userId }
    });

    if (usernameTaken) {
      return res.status(400).json({ success: false, message: 'Username is already taken' });
    }

    const user = await User.findByIdAndUpdate(
      userId, 
      { displayName: trimmedName, avatarUrl: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(trimmedName)}` }, 
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 5. Change Password (Inside Profile)
export const changePassword = async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.userId;

    if (!currentPassword || !newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }

    const user = await User.findById(userId).select('+password');
    if (!user || !user.password) {
      return res.status(404).json({ success: false, message: 'User not found or password not set' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect current password' });
    }

    if (!isPasswordStrongEnough(newPassword)) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 6. Forgot Password (Issues mock token and logs link to console)
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email address is required' });
    }

    // Generic response regardless of outcome — do not reveal whether an
    // account exists for this email (prevents user enumeration).
    const genericResponse = {
      success: true,
      message: 'If an account exists for this email address, password reset instructions have been sent.'
    };

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(200).json(genericResponse);
    }

    // Generate token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hour expiration

    resetTokensStore.set(resetToken, { email: user.email, expires });

    const resetLink = `${CLIENT_URL}/reset-password?token=${resetToken}`;
    console.log('\n======================================================');
    console.log(`PASSWORD RESET REQUEST RECEIVED FOR: ${user.email}`);
    console.log(`Link: ${resetLink}`);
    console.log('======================================================\n');

    // The reset link/token must never be returned in the API response in
    // production — that would let anyone take over any account just by
    // knowing their email. Only expose it in local development, where
    // there's no real email delivery configured yet.
    return res.status(200).json(
      env.isProduction ? genericResponse : { ...genericResponse, devResetLink: resetLink }
    );
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 7. Reset Password (Applies token check and updates credentials)
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || typeof token !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, message: 'Token and new password are required' });
    }

    const tokenDetails = resetTokensStore.get(token);
    if (!tokenDetails) {
      return res.status(400).json({ success: false, message: 'Invalid or expired password reset token' });
    }

    if (Date.now() > tokenDetails.expires) {
      resetTokensStore.delete(token);
      return res.status(400).json({ success: false, message: 'Password reset token has expired' });
    }

    if (!isPasswordStrongEnough(newPassword)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    const user = await User.findOne({ email: tokenDetails.email });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    // Invalidate token
    resetTokensStore.delete(token);

    return res.status(200).json({ success: true, message: 'Password reset successfully. You can now login.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Google OAuth Success Redirect Handler
export const googleSuccess = (req: Request, res: Response) => {
  if (!req.user) {
    return res.redirect(`${CLIENT_URL}/login?error=auth_failed`);
  }
  const token = sendTokenResponse(req.user, 200, res);
  res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`);
};

// Developer Bypass Login Route (Mock Login) — disabled outside development,
// since it authenticates as any email with no password check.
export const devLogin = async (req: Request, res: Response) => {
  if (env.isProduction) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  try {
    const { email, displayName } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email is required for mock login' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      const isFirst = (await User.countDocuments()) === 0;
      user = await User.create({
        displayName: displayName || normalizedEmail.split('@')[0],
        email: normalizedEmail,
        avatarUrl: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(email)}`,
        isPremium: false,
        isAdmin: isFirst,
        balance: 0,
        salesCount: 0
      });
    }

    const token = sendTokenResponse(user, 200, res);
    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Register Web Push subscription
export const subscribePush = async (req: AuthRequest, res: Response) => {
  try {
    const { subscription } = req.body;
    if (!subscription) {
      return res.status(400).json({ success: false, message: 'Subscription payload is required' });
    }
    await registerSubscription(req.userId!, subscription);
    return res.status(200).json({ success: true, message: 'Push subscription registered successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Get current logged-in user profile
export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        coins: user.coins || 0,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Get public VAPID key dynamically
export const getVapidKey = (req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    publicKey: env.VAPID_PUBLIC_KEY
  });
};

// Log out and clear cookies
export const logout = (req: Request, res: Response) => {
  res.cookie('token', 'none', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true
  });
  return res.status(200).json({ success: true, message: 'Logged out successfully' });
};

// Purchase hosting coins using wallet balance
export const buyCoins = async (req: AuthRequest, res: Response) => {
  const { amount } = req.body;
  if (!amount || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount) || amount > 100000) {
    return res.status(400).json({ success: false, message: 'Invalid coins amount requested' });
  }

  try {
    const config = await getGlobalConfig();
    const totalCost = amount * config.coinPrice;

    // Atomic conditional deduction — see purchaseQuiz for why a plain
    // read-check-then-save() is unsafe under concurrent requests.
    const user = await User.findOneAndUpdate(
      { _id: req.userId, balance: { $gte: totalCost } },
      { $inc: { balance: -totalCost, coins: amount } },
      { new: true }
    );

    if (!user) {
      const existing = await User.findById(req.userId).select('balance');
      if (!existing) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. You need ₦ ${totalCost.toLocaleString()} to purchase ${amount} coins. Current balance: ₦ ${existing.balance.toLocaleString()}`
      });
    }

    // Log Wallet Transaction
    await WalletTransaction.create({
      user: user._id,
      type: 'buy_coins',
      amountMoney: -totalCost,
      coinsChange: amount,
      description: `Purchased ${amount} Hosting Coins (₦ ${totalCost.toLocaleString()})`,
      status: 'completed'
    });

    return res.status(200).json({
      success: true,
      message: `Successfully purchased ${amount} game hosting coins!`,
      user: {
        id: user._id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        isAdmin: user.isAdmin,
        balance: user.balance,
        coins: user.coins,
        salesCount: user.salesCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
