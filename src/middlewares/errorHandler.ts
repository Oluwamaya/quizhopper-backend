import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

// Mounted after all routes — catches 404s and anything passed to next(err),
// plus body-parser/JSON errors. Keeps internal error details out of
// production responses.
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Resource not found' });
};

// Raw exception messages (Mongoose validation strings, driver errors, etc.)
// can reveal schema/field names and internal implementation details, so they
// should only reach the client in non-production. Controllers/sockets that
// catch their own errors (instead of calling next(err)) need this same rule
// applied manually — this is the shared helper for that.
export const getSafeErrorMessage = (err: any, fallback = 'Internal server error'): string => {
  return env.isProduction ? fallback : (err?.message || fallback);
};

// Logs the real error server-side and responds with a message safe to expose
// to the client — for the many controllers that catch their own errors rather
// than calling next(err) into the centralized handler below.
export const sendServerError = (res: Response, err: any, context: string) => {
  console.error(`${context}:`, err);
  return res.status(500).json({ success: false, message: getSafeErrorMessage(err) });
};

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }

  console.error('Unhandled error:', err);

  // Malformed JSON body
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ success: false, message: 'Malformed JSON in request body' });
  }

  // Payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request payload too large' });
  }

  const statusCode = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = env.isProduction && statusCode === 500 ? 'Internal server error' : err.message || 'Internal server error';

  return res.status(statusCode).json({ success: false, message });
};
