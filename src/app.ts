import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import passport from 'passport';
import cookieSession from 'cookie-session';
import { connectDB } from './config/db';
import { startSessionCleanupCron } from './services/cronService';

// Load environmental config
dotenv.config();

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

// Import socket setup
import { setupGameSockets } from './sockets/gameSocket';
import { setupSupportSockets } from './sockets/supportSocket';

const app = express();
const server = http.createServer(app);

// Configure Sockets with CORS
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Bind socketio instance to Express App so controllers can access it
app.set('socketio', io);

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const COOKIE_KEY = process.env.COOKIE_KEY || 'quizhopper_cookie_session_key_secret';

// Connect to MongoDB database
connectDB();

// Middlewares
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  })
);
app.use(express.json());

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

// Configure Session middleware (Required for Google Auth redirect state verification)
app.use(
  cookieSession({
    name: 'session',
    keys: [COOKIE_KEY],
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Serve static uploaded complaint attachments
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date() });
});

// Configure Socket.io handlers
setupGameSockets(io);
setupSupportSockets(io);

// Start inactive session cleanup cron scheduler
startSessionCleanupCron(io);

// Start server
server.listen(PORT, () => {
  console.log(`Quiz Hopper server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
