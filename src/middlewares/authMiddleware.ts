import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_quizhopper_2026';

// Extend Request interface to include userId and userEmail
export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  let token;

  // 1. Check Authorization header for Bearer token
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  // 2. Check cookies
  else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  // Check if token exists
  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized to access this resource' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
    
    // Attach user credentials to request
    req.userId = decoded.id;
    req.userEmail = decoded.email;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid authentication session, please log in again' });
  }
};
