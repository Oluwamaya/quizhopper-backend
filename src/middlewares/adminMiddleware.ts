import { Response, NextFunction } from 'express';
import { User } from '../models/User';
import { AuthRequest } from './authMiddleware';

export const adminProtect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied: Super Admin authorization required' });
    }
    next();
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
