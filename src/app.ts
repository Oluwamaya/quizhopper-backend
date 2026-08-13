import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import passport from 'passport';
import cookieSession from 'cookie-session';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import mongoose from 'mongoose';
import { env } from './config/env';
import { connectDB } from './config/db';
import { startSessionCleanupCron } from './services/cronService';
import { generalApiLimiter } from './middlewares/rateLimiters';
import { notFoundHandler, errorHandler } from './middlewares/errorHandler';

// Initialize passport config
import './config/passport';

import path from 'path';

// Import routes
import authRoutes from './routes/authRoutes';
import quizRoutes from './routes/quizRoutes';
import purchaseRoutes from './routes/purchaseRoutes';
import gameRoutes from './routes/gameRoutes';
import adminRoutes from './routes/adminRoutes';
import supportRoutes from './routes/supportRoutes';
import paystackRoutes from './routes/paystackRoutes';

// Import socket setup
import { setupGameSockets } from './sockets/gameSocket';
import { setupSupportSockets } from './sockets/supportSocket';

const app = express();
const server = http.createServer(app);

// Shared CORS origin check — allow any origin in the configured allow-list,
// plus non-browser/same-origin requests (no Origin header).
const corsOriginCheck = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  if (!origin || env.CLIENT_URLS.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error('Not allowed by CORS'));
};

// Configure Sockets with CORS
const io = new Server(server, {
  cors: {
    origin: corsOriginCheck,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Bind socketio instance to Express App so controllers can access it
app.set('socketio', io);

// Trust the first proxy hop (required for correct client IPs behind a
// load balancer/reverse proxy — rate limiting and secure cookies depend on it)
app.set('trust proxy', 1);

// Connect to MongoDB database
connectDB();

// Security headers. This is a JSON API (not server-rendered HTML), and the
// frontend on a separate origin loads /uploads images directly, so relax the
// cross-origin-resource-policy default and skip CSP (irrelevant for JSON/API
// responses and would otherwise need per-frontend tuning).
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

// Response compression
app.use(compression());

// HTTP request logging
app.use(morgan(env.isProduction ? 'combined' : 'dev'));

app.use(
  cors({
    origin: corsOriginCheck,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  })
);

// Explicit body size limit. Base64 encoding inflates binary size by ~33%,
// and /support/upload allows files up to 5MB, so the limit needs headroom
// above that — bounded well below "unlimited" to prevent memory-exhaustion
// DoS via huge payloads. `verify` stashes the raw bytes so the Paystack
// webhook can HMAC the exact payload Paystack signed — re-serializing the
// parsed JSON can reorder/reformat it and break signature verification.
app.use(
  express.json({
    limit: '9mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  })
);

// Custom cookie-parser middleware to parse req.cookies without extra packages
app.use((req: any, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach((cookie: string) => {
      const parts = cookie.split('=');
      const name = parts[0].trim();
      const val = parts.slice(1).join('=');
      req.cookies[name] = decodeURIComponent(val || '');
    });
  }
  next();
});

// Strip any Mongo query operators ($, .) from user input to prevent NoSQL injection
app.use(mongoSanitize());

// Guard against HTTP Parameter Pollution (duplicate query keys)
app.use(hpp());

// Configure Session middleware (Required for Google Auth redirect state verification)
app.use(
  cookieSession({
    name: 'session',
    keys: [env.COOKIE_KEY],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: env.isProduction,
    sameSite: 'lax'
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Global rate limit across the whole API surface (tighter, route-specific
// limiters are applied on top of this for sensitive endpoints)
app.use('/api', generalApiLimiter);

// Serve static uploaded complaint attachments
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/wallet/paystack', paystackRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date() });
});

// 404 + centralized error handling (must be mounted last)
app.use(notFoundHandler);
app.use(errorHandler);

// Configure Socket.io handlers
setupGameSockets(io);
setupSupportSockets(io);

// Start inactive session cleanup cron scheduler
startSessionCleanupCron(io);

// Start server
server.listen(env.PORT, () => {
  console.log(`Quiz Hopper server running in ${env.NODE_ENV} mode on port ${env.PORT}`);
});

// Graceful shutdown — stop accepting new connections and close DB/IO cleanly
const shutdown = (signal: string) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await mongoose.connection.close();
      console.log('MongoDB connection closed.');
    } catch (err) {
      console.error('Error closing MongoDB connection:', err);
    } finally {
      process.exit(0);
    }
  });

  // Force-exit if shutdown hangs
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
