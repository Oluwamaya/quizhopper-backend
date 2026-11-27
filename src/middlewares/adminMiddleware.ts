import { Response, NextFunction } from 'express';
import { User } from '../models/User';
import { AuthRequest } from './authMiddleware';
import { sendServerError } from './errorHandler';

// Allows either a Jackpot Admin (`isAdmin`) OR a Super Admin (`isSuperAdmin`).
// Attaches `req.isAdmin` and `req.isSuperAdmin` so downstream handlers (like
// Jackpot room listing) can strip user PII for non-Super-Admin accounts.
export const adminProtect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.userId).select('isAdmin isSuperAdmin');
    if (!user || (!user.isAdmin && !user.isSuperAdmin)) {
      return res.status(403).json({ success: false, message: 'Access denied: Admin authorization required' });
    }
    req.isAdmin = Boolean(user.isAdmin || user.isSuperAdmin);
    req.isSuperAdmin = Boolean(user.isSuperAdmin);
    next();
  } catch (error: any) {
    return sendServerError(res, error, 'adminProtect');
  }
};

// Restricts sensitive platform surfaces (analytics, user management, wallet
// ledgers, support tickets, rules/economy, broadcasts) strictly to Super Admin.
export const superAdminProtect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.userId).select('isAdmin isSuperAdmin');
    if (!user || !user.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied: Super Admin authorization required' });
    }
    req.isAdmin = true;
    req.isSuperAdmin = true;
    next();
  } catch (error: any) {
    return sendServerError(res, error, 'superAdminProtect');
  }
};
