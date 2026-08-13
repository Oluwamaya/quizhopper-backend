import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

// Mounted after all routes — catches 404s and anything passed to next(err),
// plus body-parser/JSON errors. Keeps internal error details out of
// production responses.
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Resource not found' });
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
