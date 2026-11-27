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
import { setCache, getCache, deleteCache } from '../services/redisService';
import { emitAdminTransaction, emitWalletUpdate } from '../utils/adminEvents';
import { sendServerError } from '../middlewares/errorHandler';
import {
  isEmailConfigured,
  sendPasswordChangedEmail,
  sendPasswordResetEmail
} from '../services/emailService';

const JWT_SECRET = env.JWT_SECRET;
const CLIENT_URL = env.CLIENT_URL;

// Minimum acceptable password strength for new/changed passwords
const isPasswordStrongEnough = (password: string): boolean => {
  return typeof password === 'string' && password.length >= 8;
};

const RESET_TTL_SECONDS = 15 * 60; // 15 minutes
const MAX_CODE_ATTEMPTS = 5;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashSecret = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const timingSafeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};

const resetTokenCacheKey = (tokenHash: string) => `pwreset:tok:${tokenHash}`;
const resetCodeCacheKey = (email: string) => `pwreset:code:${email}`;

const findUserByEmailCaseInsensitive = (email: string, includePassword = false) => {
  const normalized = email.trim().toLowerCase();
  const query = User.findOne({
    email: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' }
  });
  return includePassword ? query.select('+password') : query;
};

interface StoredResetCodePayload {
  codeHash: string;
  tokenHash: string;
  attempts: number;
}

// Issues a single-use reset token + 6-digit code (both stored only as SHA-256
// hashes with 15-min TTL) and emails them via ZeptoMail.
const issuePasswordVerificationChallenge = async (user: any) => {
  const normalizedEmail = user.email.trim().toLowerCase();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const rawCode = crypto.randomInt(100000, 1000000).toString();

  const tokenHash = hashSecret(rawToken);
  const codeHash = hashSecret(rawCode);

  // If a prior code/token existed for this email, clean up the old token too
  const previousRaw = await getCache(resetCodeCacheKey(normalizedEmail));
  if (previousRaw) {
    try {
      const prev = JSON.parse(previousRaw) as StoredResetCodePayload;
      if (prev.tokenHash) await deleteCache(resetTokenCacheKey(prev.tokenHash));
    } catch {
      // ignore malformed legacy entry
    }
  }

  await setCache(resetTokenCacheKey(tokenHash), normalizedEmail, RESET_TTL_SECONDS);
  await setCache(
    resetCodeCacheKey(normalizedEmail),
    JSON.stringify({ codeHash, tokenHash, attempts: 0 } satisfies StoredResetCodePayload),
    RESET_TTL_SECONDS
  );

  const resetLink = `${CLIENT_URL}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;
  const isGoogleSetup = !user.password && Boolean(user.googleId);

  const emailResult = await sendPasswordResetEmail({
    to: normalizedEmail,
    name: user.displayName || normalizedEmail.split('@')[0],
    resetLink,
    code: rawCode,
    isGoogleSetup
  });

  if (!env.isProduction && !emailResult.sent) {
    console.log('\n======================================================');
    console.log(`PASSWORD VERIFICATION REQUEST FOR: ${normalizedEmail}`);
    console.log(`6-Digit Code: ${rawCode}`);
    console.log(`Reset Link:   ${resetLink}`);
    console.log('======================================================\n');
  }

  return {
    resetLink,
    rawCode,
    emailSent: emailResult.sent,
    isGoogleSetup
  };
};

// Helper to normalize and validate optional phone numbers
const validatePhone = (raw: unknown): { valid: boolean; value: string; error?: string } => {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return { valid: false, value: '', error: 'Invalid phone number format' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true, value: '' };
  }
  if (trimmed.length > 20 || !/^[+]?[\d\s\-()]{7,20}$/.test(trimmed)) {
    return { valid: false, value: '', error: 'Please enter a valid phone number (7–20 digits, e.g. +2348012345678 or 08012345678)' };
  }
  const digitCount = trimmed.replace(/\D/g, '').length;
  if (digitCount < 7 || digitCount > 15) {
    return { valid: false, value: '', error: 'Phone number must contain between 7 and 15 digits' };
  }
  return { valid: true, value: trimmed };
};

const serializeAuthUser = (user: any, hasPasswordOverride?: boolean) => ({
  id: user._id,
  displayName: user.displayName,
  email: user.email,
  phone: user.phone || '',
  avatarUrl: user.avatarUrl,
  isPremium: user.isPremium,
  isAdmin: Boolean(user.isAdmin || user.isSuperAdmin),
  isSuperAdmin: Boolean(user.isSuperAdmin),
  balance: user.balance,
  coins: user.coins || 0,
  salesCount: user.salesCount,
  hasGoogle: Boolean(user.googleId),
  ...(hasPasswordOverride !== undefined
    ? { hasPassword: hasPasswordOverride }
    : (user.password !== undefined ? { hasPassword: Boolean(user.password) } : {}))
});

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

    // Check if email already registered (case-insensitive to match Google signups too)
    const userExists = await findUserByEmailCaseInsensitive(normalizedEmail, true);
    if (userExists) {
      if (!userExists.password && userExists.googleId) {
        return res.status(409).json({
          success: false,
          code: 'NEEDS_PASSWORD_SETUP',
          message: 'An account with this email already exists via Google Sign-In. Sign in with Google, or use "Set / Reset Password" to verify your email and add a password.'
        });
      }
      return res.status(400).json({ success: false, message: 'Email address is already in use' });
    }

    // Encrypt password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const isFirstUser = (await User.countDocuments()) === 0;
    const config = await getGlobalConfig();

    const user = await User.create({
      displayName: displayName.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      avatarUrl: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(displayName)}`,
      isAdmin: isFirstUser,
      isSuperAdmin: isFirstUser,
      isPremium: false,
      balance: 0,
      coins: config.signupCoinGift,
      salesCount: 0
    });

    if (config.signupCoinGift > 0) {
      await WalletTransaction.create({
        user: user._id,
        type: 'signup_bonus',
        coinsChange: config.signupCoinGift,
        amountMoney: 0,
        description: `Welcome bonus: ${config.signupCoinGift} free hosting coins`,
        status: 'completed'
      });
    }

    const token = sendTokenResponse(user, 201, res);

    return res.status(201).json({
      success: true,
      token,
      user: serializeAuthUser(user)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'register');
  }
};

// 2. Standard User Login (Checks email + password)
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await findUserByEmailCaseInsensitive(email, true);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Account exists via Google Sign-In but has no password yet — guide user
    // to either continue with Google OR verify email via code/link to set one.
    if (!user.password) {
      return res.status(401).json({
        success: false,
        code: 'NEEDS_PASSWORD_SETUP',
        message: 'This email is registered with Google and has no password yet. Continue with Google, or click "Set / Reset Password" to verify your email and create a password.'
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Self-heal legacy mixed-case email if needed
    const normalizedEmail = email.trim().toLowerCase();
    if (user.email !== normalizedEmail) {
      user.email = normalizedEmail;
      await user.save();
    }

    const token = sendTokenResponse(user, 200, res);

    return res.status(200).json({
      success: true,
      token,
      user: serializeAuthUser(user, true)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'login');
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

    if (!user.isAdmin && !user.isSuperAdmin) {
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
      user: serializeAuthUser(user)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'adminLogin');
  }
};

// 4. Update Profile (DisplayName/Username + Phone number)
export const updateProfile = async (req: AuthRequest, res: Response) => {
  try {
    const { displayName, phone } = req.body;
    const userId = req.userId;

    const updateFields: Record<string, any> = {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || !displayName.trim()) {
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

      updateFields.displayName = trimmedName;
      updateFields.avatarUrl = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(trimmedName)}`;
    }

    if (phone !== undefined) {
      const phoneCheck = validatePhone(phone);
      if (!phoneCheck.valid) {
        return res.status(400).json({ success: false, message: phoneCheck.error });
      }
      updateFields.phone = phoneCheck.value;
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const user = await User.findByIdAndUpdate(
      userId, 
      updateFields, 
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: serializeAuthUser(user)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'updateProfile');
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
    user.passwordChangedAt = new Date();
    await user.save();

    // Re-issue fresh token for this device so the user stays signed in while
    // every previously issued JWT on other devices is invalidated immediately.
    const freshToken = sendTokenResponse(user, 200, res);
    sendPasswordChangedEmail({ to: user.email, name: user.displayName }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully',
      token: freshToken
    });
  } catch (error: any) {
    return sendServerError(res, error, 'changePassword');
  }
};

// 5b. Request verification code for a logged-in Google user to set their password
export const requestSetPasswordCode = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.password) {
      return res.status(400).json({ success: false, message: 'Your account already has a password. Use Change Password instead.' });
    }

    const issued = await issuePasswordVerificationChallenge(user);

    return res.status(200).json({
      success: true,
      emailSent: issued.emailSent,
      message: issued.emailSent
        ? `A 6-digit verification code has been sent to ${user.email}.`
        : 'Verification code generated (email delivery is not configured yet in this environment).',
      ...(!env.isProduction && !issued.emailSent ? { devCode: issued.rawCode } : {})
    });
  } catch (error: any) {
    return sendServerError(res, error, 'requestSetPasswordCode');
  }
};

// 5c. Verify code and set initial password for a logged-in Google user (keeps Google Sign-In working!)
export const setPasswordWithCode = async (req: AuthRequest, res: Response) => {
  try {
    const { code, newPassword } = req.body || {};
    if (!code || !newPassword || typeof code !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, message: 'Verification code and new password are required' });
    }
    if (!isPasswordStrongEnough(newPassword)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const normalizedEmail = user.email.trim().toLowerCase();
    const storedRaw = await getCache(resetCodeCacheKey(normalizedEmail));
    if (!storedRaw) {
      return res.status(400).json({ success: false, message: 'Verification code expired or not requested. Please request a new code.' });
    }

    let payload: StoredResetCodePayload;
    try {
      payload = JSON.parse(storedRaw);
    } catch {
      await deleteCache(resetCodeCacheKey(normalizedEmail));
      return res.status(400).json({ success: false, message: 'Invalid verification state. Please request a new code.' });
    }

    if (payload.attempts >= MAX_CODE_ATTEMPTS) {
      await deleteCache(resetCodeCacheKey(normalizedEmail));
      if (payload.tokenHash) await deleteCache(resetTokenCacheKey(payload.tokenHash));
      return res.status(429).json({ success: false, message: 'Too many invalid attempts. Please request a new verification code.' });
    }

    const providedHash = hashSecret(code.trim());
    if (!timingSafeEqualHex(providedHash, payload.codeHash)) {
      payload.attempts += 1;
      await setCache(resetCodeCacheKey(normalizedEmail), JSON.stringify(payload), RESET_TTL_SECONDS);
      return res.status(400).json({ success: false, message: 'Invalid verification code. Please check your email and try again.' });
    }

    // Single-use: revoke both code and link token immediately
    await deleteCache(resetCodeCacheKey(normalizedEmail));
    if (payload.tokenHash) await deleteCache(resetTokenCacheKey(payload.tokenHash));

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.passwordChangedAt = new Date();
    user.email = normalizedEmail;
    await user.save();

    const freshToken = sendTokenResponse(user, 200, res);
    sendPasswordChangedEmail({ to: normalizedEmail, name: user.displayName }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Password set successfully! You can now sign in with either Google or Email & Password.',
      token: freshToken,
      user: serializeAuthUser(user, true)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'setPasswordWithCode');
  }
};

// 6. Forgot / Set Password (Sends real ZeptoMail verification link + 6-digit code)
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
      emailConfigured: isEmailConfigured(),
      message: 'If an account exists for this email address, a verification code and reset link have been sent to your inbox.'
    };

    const user = await findUserByEmailCaseInsensitive(email, true);
    if (!user) {
      return res.status(200).json(genericResponse);
    }

    const issued = await issuePasswordVerificationChallenge(user);

    // Never expose the reset link/code in production OR once ZeptoMail is live.
    if (!env.isProduction && !issued.emailSent) {
      return res.status(200).json({
        ...genericResponse,
        devResetLink: issued.resetLink,
        devCode: issued.rawCode
      });
    }

    return res.status(200).json(genericResponse);
  } catch (error: any) {
    return sendServerError(res, error, 'forgotPassword');
  }
};

// 7. Reset / Set Password (Supports either link `token` OR `email` + 6-digit `code`)
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, email, code, newPassword } = req.body || {};

    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, message: 'New password is required' });
    }

    if (!isPasswordStrongEnough(newPassword)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    let verifiedEmail: string | null = null;

    if (token && typeof token === 'string') {
      const tokenHash = hashSecret(token.trim());
      const cachedEmail = await getCache(resetTokenCacheKey(tokenHash));
      if (!cachedEmail) {
        return res.status(400).json({ success: false, message: 'Invalid or expired password reset link' });
      }
      // Single-use: delete both token and companion code immediately
      await deleteCache(resetTokenCacheKey(tokenHash));
      await deleteCache(resetCodeCacheKey(cachedEmail));
      verifiedEmail = cachedEmail;
    } else if (email && code && typeof email === 'string' && typeof code === 'string') {
      const normalizedEmail = email.trim().toLowerCase();
      const storedRaw = await getCache(resetCodeCacheKey(normalizedEmail));
      if (!storedRaw) {
        return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
      }

      let payload: StoredResetCodePayload;
      try {
        payload = JSON.parse(storedRaw);
      } catch {
        await deleteCache(resetCodeCacheKey(normalizedEmail));
        return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
      }

      if (payload.attempts >= MAX_CODE_ATTEMPTS) {
        await deleteCache(resetCodeCacheKey(normalizedEmail));
        if (payload.tokenHash) await deleteCache(resetTokenCacheKey(payload.tokenHash));
        return res.status(429).json({ success: false, message: 'Too many invalid attempts. Please request a new reset code.' });
      }

      const providedHash = hashSecret(code.trim());
      if (!timingSafeEqualHex(providedHash, payload.codeHash)) {
        payload.attempts += 1;
        await setCache(resetCodeCacheKey(normalizedEmail), JSON.stringify(payload), RESET_TTL_SECONDS);
        return res.status(400).json({ success: false, message: 'Invalid verification code. Please check your email and try again.' });
      }

      // Single-use: revoke both code and link token immediately
      await deleteCache(resetCodeCacheKey(normalizedEmail));
      if (payload.tokenHash) await deleteCache(resetTokenCacheKey(payload.tokenHash));
      verifiedEmail = normalizedEmail;
    } else {
      return res.status(400).json({ success: false, message: 'Provide either a reset link token or your email and 6-digit verification code' });
    }

    const user = await findUserByEmailCaseInsensitive(verifiedEmail, true);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.passwordChangedAt = new Date();
    user.email = verifiedEmail;
    await user.save();

    sendPasswordChangedEmail({ to: verifiedEmail, name: user.displayName }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: user.googleId
        ? 'Password updated! You can now sign in with Email & Password or continue using Google.'
        : 'Password reset successfully. You can now log in with your new password.'
    });
  } catch (error: any) {
    return sendServerError(res, error, 'resetPassword');
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
      const config = await getGlobalConfig();
      user = await User.create({
        displayName: displayName || normalizedEmail.split('@')[0],
        email: normalizedEmail,
        avatarUrl: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(email)}`,
        isPremium: false,
        isAdmin: isFirst,
        isSuperAdmin: isFirst,
        balance: 0,
        coins: config.signupCoinGift,
        salesCount: 0
      });

      if (config.signupCoinGift > 0) {
        await WalletTransaction.create({
          user: user._id,
          type: 'signup_bonus',
          coinsChange: config.signupCoinGift,
          amountMoney: 0,
          description: `Welcome bonus: ${config.signupCoinGift} free hosting coins`,
          status: 'completed'
        });
      }
    }

    const token = sendTokenResponse(user, 200, res);
    return res.status(200).json({
      success: true,
      token,
      user: serializeAuthUser(user)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'devLogin');
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
    return sendServerError(res, error, 'subscribePush');
  }
};

// Get current logged-in user profile
export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      user: serializeAuthUser(user, Boolean(user.password))
    });
  } catch (error: any) {
    return sendServerError(res, error, 'getMe');
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
    const txn = await WalletTransaction.create({
      user: user._id,
      type: 'buy_coins',
      amountMoney: -totalCost,
      coinsChange: amount,
      description: `Purchased ${amount} Hosting Coins (₦ ${totalCost.toLocaleString()})`,
      status: 'completed'
    });
    emitAdminTransaction(req.app.get('socketio'), txn);
    emitWalletUpdate(req.app.get('socketio'), String(user._id), { coins: user.coins, balance: user.balance });

    return res.status(200).json({
      success: true,
      message: `Successfully purchased ${amount} game hosting coins!`,
      user: serializeAuthUser(user)
    });
  } catch (error: any) {
    return sendServerError(res, error, 'buyCoins');
  }
};
