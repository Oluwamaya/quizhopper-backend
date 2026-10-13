import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const JWT_SECRET = env.JWT_SECRET;

// Extend Request interface to include userId and userEmail
export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

// Decodes a JWT if one is present, but never rejects the request when it's
// missing or invalid — for routes anonymous guests can also reach (the
// support widget), where we want to recognize a logged-in visitor when
// possible without requiring login.
export const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
      req.userId = decoded.id;
      req.userEmail = decoded.email;
    } catch {
      // Expired/invalid token on an otherwise-anonymous route — proceed as guest.
    }
  }

  next();
};

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
