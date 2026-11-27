import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { Quiz } from '../models/Quiz';
import { User } from '../models/User';
import { getGlobalConfig } from '../models/AppConfig';
import { GameSession } from '../models/GameSession';
import { WalletTransaction } from '../models/WalletTransaction';
import { setRoomCache, getRoomCache, delRoomCache, withRoomLock } from '../services/redisService';
import { env } from '../config/env';
import { emitAdminTransaction, emitWalletUpdate } from '../utils/adminEvents';
import { getSafeErrorMessage } from '../middlewares/errorHandler';
import { isTokenRevokedByPasswordChange } from '../middlewares/authMiddleware';
import { censorMessage, validateChatMessage, isChatRateLimited, clearChatRateLimit } from '../utils/chatModeration';
import {
  buildRandomizedQuestions,
  buildTop5Winners,
  cancelAndRefundJackpotRoom,
  emitJackpotLiveUpdate,
  getSessionQuestions,
  notifyJackpotWinnersByEmail,
  rankJackpotPlayers,
  refundSingleJackpotEntry
} from '../services/jackpotService';

const JWT_SECRET = env.JWT_SECRET;

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

// Same rationale as sendServerError in errorHandler.ts, applied to socket
// error emits instead of HTTP responses: log the real exception server-side,
// only forward a raw message to the client outside production.
const emitSocketError = (socket: Socket, err: any, context: string) => {
  console.error(`${context}:`, err);
  socket.emit('error', { message: getSafeErrorMessage(err, 'Something went wrong. Please try again.') });
};

// Track active timers by game pin
const activeTimers: { [gamePin: string]: NodeJS.Timeout } = {};

// In-memory cache of each active room's quiz document. player_submit_answer
// runs inside a per-room lock (see withRoomLock) that serializes concurrent
// answers, so any awaited work inside it directly multiplies into the queue
// depth — re-fetching the quiz from Mongo on every single answer would mean
// 50 simultaneous answers pay 50 serialized Atlas round-trips back to back.
// The quiz never changes mid-game, so it's fetched once and reused.
const activeQuizzes: { [gamePin: string]: any } = {};

// In-memory cache of each active room's live session state — the same
// reasoning as activeQuizzes above, applied to the session document itself.
// player_join_lobby and player_submit_answer both run their read-modify-write
// inside withRoomLock, so every AWAITED Redis round-trip in there multiplies
// directly into how long the whole queue of concurrent players waits (measured:
// with 100 players, awaiting a Redis get+set per answer serialized out to
// 60-75+ seconds per question and climbing, since the cached payload grows
// every question). Once a room is warm here, reads never hit Redis at all,
// and writes are fired off without being awaited — Redis stays a resilience
// checkpoint (still authoritative for reconnect/restart), not a per-message
// blocking dependency. Safe because this app runs as a single instance; if
// it's ever horizontally scaled, this cache needs to become instance-shared.
const activeSessions: { [gamePin: string]: any } = {};

// Reads the live session for a room, preferring the in-memory cache (always
// current within this process) over Redis/Mongo, and warms the cache on a
// cold read so subsequent calls in the same room skip the network entirely.
const getActiveSession = async (gamePin: string, requiredState?: string): Promise<any | null> => {
  if (activeSessions[gamePin]) {
    return activeSessions[gamePin];
  }
  let session = await getRoomCache(gamePin);
  if (!session) {
    const query: any = { gamePin };
    if (requiredState) query.state = requiredState;
    const dbSession = await GameSession.findOne(query);
    if (dbSession) session = dbSession.toObject();
  }
  if (session) {
    activeSessions[gamePin] = session;
  }
  return session;
};

// Updates the in-memory session cache and fires off a Redis checkpoint write
// without awaiting it — callers inside withRoomLock must not block the lock
// queue on a network round-trip. Mongo remains the durable record (already
// written separately, also non-blocking) and Redis remains the cross-restart
// checkpoint; the in-memory cache is what every read in this process actually
// uses while the room is active.
const syncSession = (gamePin: string, session: any) => {
  activeSessions[gamePin] = session;
  setRoomCache(gamePin, session).catch((err) => console.error(`Redis checkpoint failed for room:${gamePin}:`, err));
};

const clearActiveSession = (gamePin: string) => {
  delete activeSessions[gamePin];
};

// Clears every in-memory trace of a room: the session cache, the quiz cache,
// and any pending question timer. Every place a room can end — the game
// finishing normally, the host closing it, or the inactivity cron force-closing
// an abandoned lobby/match — must call this, or that room's entry (quiz
// document, growing player/answers list) sits in process memory forever until
// the next restart, since these maps are private module state the cron has no
// other way to reach.
export const clearRoomMemory = (gamePin: string) => {
  clearActiveSession(gamePin);
  delete activeQuizzes[gamePin];
  if (activeTimers[gamePin]) {
    clearTimeout(activeTimers[gamePin]);
    delete activeTimers[gamePin];
  }
};

// Registers a newly created room (e.g. from the HTTP Jackpot controller) into
// the live in-memory + Redis caches so host/player socket events see it right away.
export const registerActiveRoom = async (gamePin: string, sessionObj: any, quizDoc: any) => {
  await setRoomCache(gamePin, sessionObj);
  activeSessions[gamePin] = sessionObj;
  if (quizDoc) {
    activeQuizzes[gamePin] = quizDoc;
  }
};

// Synchronizes a player who just paid via the atomic HTTP Jackpot join route
// into the live room cache and broadcasts lobby_update to everyone in the room.
export const syncPaidJackpotPlayerToActiveRoom = async (
  io: Server | undefined | null,
  gamePin: string,
  newPlayer: any
) => {
  const playersList = await withRoomLock(gamePin, async () => {
    const session = await getActiveSession(gamePin);
    if (!session) return null;

    const alreadyPresent = session.players.some(
      (p: any) => p.userId && newPlayer.userId && String(p.userId) === String(newPlayer.userId)
    );
    if (!alreadyPresent) {
      session.players.push({
        ...newPlayer,
        userId: newPlayer.userId ? String(newPlayer.userId) : undefined
      });
      if (session.jackpot) {
        session.jackpot.paidSeatsCount = Math.max(
          (session.jackpot.paidSeatsCount || 0) + 1,
          session.players.length
        );
      }
      syncSession(gamePin, session);
    }

    return session.players.map((p: any) => ({
      nickname: p.nickname,
      avatar: p.avatar
    }));
  });

  if (io && playersList) {
    io.to(`room:${gamePin}`).emit('lobby_update', { players: playersList });
  }
};

// Cleans up caches/timers and evicts all sockets from an active room.
export const forceCloseActiveRoom = async (
  io: Server | undefined | null,
  gamePin: string,
  message: string
) => {
  await delRoomCache(gamePin);
  clearRoomMemory(gamePin);

  if (!io) return;

  io.to(`room:${gamePin}`).emit('room_closed', { message });

  const roomName = `room:${gamePin}`;
  const activeSocketsInRoom = io.sockets.adapter.rooms.get(roomName);
  if (activeSocketsInRoom) {
    for (const socketId of activeSocketsInRoom) {
      const clientSocket = io.sockets.sockets.get(socketId);
      if (clientSocket) {
        clientSocket.leave(roomName);
      }
    }
  }
};

// Socket.IO's own `.connected` flag only reflects what its heartbeat has
// detected SO FAR — a connection that died without a clean close (phone
// lost signal, wifi dropped) can still read as "connected" for up to the
// full ping interval + timeout (~20s on this server's config) after it
// actually died. For deciding whether a nickname can be reclaimed, that's
// too slow a fallback to lean on alone, so this does a real-time check
// instead: ping the socket and wait briefly for an actual reply.
//
// Deliberately NOT called from inside withRoomLock. A 2.5s wait inside
// the per-room lock would serialize every other action in that room
// behind it — exactly the shape of bug that caused the OOM crash during
// the 100-player load test (a cheap-looking op placed inside the lock
// turning into a pile-up under load). Callers probe here first, outside
// any lock, then re-verify the cheap synchronous flag once inside the
// lock immediately before committing.
const confirmSocketAlive = async (io: Server, socketId: string): Promise<boolean> => {
  const target = io.sockets.sockets.get(socketId);
  if (!target || !target.connected) return false;

  try {
    const acked = await new Promise<boolean>((resolve) => {
      target.timeout(2500).emit('presence_check', (err: any) => resolve(!err));
    });
    if (acked) return true; // confirmed alive — in practice this is near-instant

    // No ack within 2.5s does NOT prove the connection is dead — on the
    // congested shared wifi this app actually runs on (church/school events,
    // many devices on one access point — see the ping/pong timing comment
    // on the Server() config in app.ts), a genuinely-connected client can
    // easily take longer than that without being dead. Treating silence
    // alone as proof of death would let a nickname be reclaimed during
    // ordinary network jitter — a narrower, timing-based version of the
    // exact hijack this whole check exists to prevent. So a timeout only
    // ever defers to Socket.IO's own independent heartbeat verdict, never
    // substitutes for it: if THAT has also concluded the connection is
    // gone by now, trust it; if it still says connected, play it safe.
    return !!io.sockets.sockets.get(socketId)?.connected;
  } catch {
    return true; // fail safe: an error probing is not proof of death
  }
};

export const setupGameSockets = (io: Server) => {
  // Socket auth middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token && typeof token === 'string') {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; iat?: number };
        const revoked = await isTokenRevokedByPasswordChange(decoded.id, decoded.iat);
        if (!revoked) {
          socket.userId = decoded.id;
          socket.userEmail = decoded.email;
        }
      } catch (err) {
        console.log('Socket connection without auth token validation:', socket.id);
      }
    }
    next();
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log('Client connected:', socket.id);

    // Every authenticated connection joins its own private per-user room,
    // so any server-side code that changes this user's coins/balance can
    // push them a live update regardless of which socket/tab they're on —
    // including cases with no HTTP response to piggyback an update onto,
    // like a Paystack webhook crediting a deposit asynchronously.
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // --- HOST HANDLERS ---

    // 1. Host creates a game lobby
    socket.on('host_create_lobby', async ({ quizId, playerLimitTier }: { quizId: string; playerLimitTier?: number }) => {
      try {
        if (!socket.userId) {
          return socket.emit('error', { message: 'Authentication required to host games' });
        }

        const quiz = await Quiz.findById(quizId);
        if (!quiz) {
          return socket.emit('error', { message: 'Quiz not found' });
        }

        // Fetch system configurations
        const config = await getGlobalConfig();
        const freeTierLimit = config.freeTierLimit || 5;
        const extraPlayerCoinCost = config.extraPlayerCoinCost || 2;

        let playerLimit = freeTierLimit;
        let coinCost = 0;

        // Any capacity above the free tier costs coins linearly, not just a fixed set of presets
        if (playerLimitTier && Number.isFinite(playerLimitTier) && playerLimitTier > freeTierLimit) {
          playerLimit = Math.min(1000, Math.floor(playerLimitTier));
          coinCost = (playerLimit - freeTierLimit) * extraPlayerCoinCost;
        }

        // Find user and check coins
        const userPreview = await User.findById(socket.userId);
        if (!userPreview) {
          return socket.emit('error', { message: 'Host account not found' });
        }

        if (userPreview.coins < coinCost) {
          return socket.emit('error', { message: `Insufficient coins. This tier requires ${coinCost} coins. Your current balance is ${userPreview.coins} coins.` });
        }

        // Generate a unique 6-digit Game Pin
        let gamePin = Math.floor(100000 + Math.random() * 900000).toString();
        let existingSession = await GameSession.findOne({ gamePin, state: { $nin: ['FINISHED', 'CANCELLED'] } });
        while (existingSession) {
          gamePin = Math.floor(100000 + Math.random() * 900000).toString();
          existingSession = await GameSession.findOne({ gamePin, state: { $nin: ['FINISHED', 'CANCELLED'] } });
        }

        // Deduct coins if cost is greater than 0. Atomic conditional update
        // (coins >= coinCost in the filter) so two lobbies created back to
        // back can't both pass a stale coin check and double-spend.
        let user = userPreview;
        if (coinCost > 0) {
          const deducted = await User.findOneAndUpdate(
            { _id: socket.userId, coins: { $gte: coinCost } },
            { $inc: { coins: -coinCost } },
            { new: true }
          );
          if (!deducted) {
            return socket.emit('error', { message: `Insufficient coins. This tier requires ${coinCost} coins.` });
          }
          user = deducted;
          const txn = await WalletTransaction.create({
            user: socket.userId,
            type: 'host_game',
            coinsChange: -coinCost,
            amountMoney: 0,
            description: `Hosted game session for "${quiz.title}" (${playerLimit} players)`,
            status: 'completed'
          });
          emitAdminTransaction(io, txn);
          emitWalletUpdate(io, socket.userId, { coins: user.coins });
        }

        // Create the session
        const session = await GameSession.create({
          gamePin,
          host: socket.userId,
          quiz: quizId,
          state: 'LOBBY',
          currentQuestionIndex: 0,
          backgroundMusic: 'off',
          playerLimit,
          players: []
        });

        const sessionObj: any = session.toObject();
        // In-memory/cache-only convenience field (never written to Mongo —
        // not part of the schema) so chat messages can label the host by
        // name without a DB lookup on every single message sent.
        sessionObj.hostDisplayName = user.displayName;
        // Seed cache — awaited here since it's once per lobby, not once per
        // player action, so blocking briefly is fine.
        await setRoomCache(gamePin, sessionObj);
        activeSessions[gamePin] = sessionObj;
        activeQuizzes[gamePin] = quiz;

        socket.join(`room:${gamePin}`);
        console.log(`Host created lobby room:${gamePin} (Limit: ${playerLimit}, Coins spent: ${coinCost})`);

        socket.emit('lobby_created', {
          gamePin,
          quizTitle: quiz.title,
          totalQuestions: quiz.questions.length,
          playerLimit,
          coinsDeducted: coinCost,
          remainingCoins: user.coins,
          chatEnabled: sessionObj.chatEnabled !== false
        });
      } catch (err: any) {
        emitSocketError(socket, err, 'host_create_lobby');
      }
    });

    // Host changes lobby background music
    socket.on('host_change_lobby_music', async ({ gamePin, lobbyMusic }: { gamePin: string; lobbyMusic: string }) => {
      try {
        const session = await getActiveSession(gamePin);
        if (!session) return;

        session.lobbyMusic = lobbyMusic;
        syncSession(gamePin, session);

        // Broadcast to all players in the lobby room
        io.to(`room:${gamePin}`).emit('lobby_music_changed', { lobbyMusic });
      } catch (e) {
        console.error('Change lobby music error:', e);
      }
    });

    // 2. Host starts the game
    socket.on('host_start_game', async ({ gamePin, backgroundMusic }: { gamePin: string; backgroundMusic?: string }) => {
      try {
        const session = await getActiveSession(gamePin, 'LOBBY');

        if (!session) {
          return socket.emit('error', { message: 'Lobby not found or already started' });
        }

        if (session.host.toString() !== socket.userId) {
          return socket.emit('error', { message: 'Only the host can start this game' });
        }

        const quiz = await Quiz.findById(session.quiz);
        if (!quiz || quiz.questions.length === 0) {
          return socket.emit('error', { message: 'Quiz questions not found' });
        }
        activeQuizzes[gamePin] = quiz;

        // For Jackpot rooms, freshly randomize question and answer order at start
        // and store it durably on the session so host, players, reconnects, and
        // server-side grading all reference the exact same shuffled sequence.
        if (session.isJackpot) {
          session.randomizedQuestions = buildRandomizedQuestions(
            quiz.questions,
            session.jackpot?.defaultTimeLimit
          );
        }

        const questions = getSessionQuestions(session, quiz);
        if (questions.length === 0) {
          return socket.emit('error', { message: 'Quiz questions not found' });
        }

        // Set state to active
        session.state = 'QUESTION_ACTIVE';
        session.currentQuestionIndex = 0;
        session.questionActiveSince = new Date(Date.now() + 2000);
        session.backgroundMusic = backgroundMusic || 'off';

        const startUpdate: any = {
          state: 'QUESTION_ACTIVE',
          currentQuestionIndex: 0,
          questionActiveSince: session.questionActiveSince,
          backgroundMusic: session.backgroundMusic
        };
        if (session.isJackpot && session.randomizedQuestions) {
          startUpdate.randomizedQuestions = session.randomizedQuestions;
        }

        // Update database in background
        GameSession.findByIdAndUpdate(session._id, startUpdate)
          .catch(err => console.error('DB Update error:', err));

        // Update cache. Non-blocking: even once-per-question writes shouldn't
        // block the response on a network round-trip — measured on a 100-player
        // room, the payload itself (all players' accumulated answers) grows
        // large enough over a long quiz that a single blocking write here
        // still added a real, growing delay between questions.
        syncSession(gamePin, session);

        if (session.isJackpot) {
          emitJackpotLiveUpdate(io);
        }

        const firstQuestion = questions[0];

        // Broadcast to room that the game has started
        io.to(`room:${gamePin}`).emit('game_started');

        // Delay emitting the first question by 2000ms to allow client-side page routing to mount GameRoom
        setTimeout(() => {
          const liveSession = activeSessions[gamePin];
          if (!liveSession || liveSession.state !== 'QUESTION_ACTIVE') return;

          liveSession.questionActiveSince = new Date();
          GameSession.findByIdAndUpdate(liveSession._id, {
            questionActiveSince: liveSession.questionActiveSince
          }).catch(err => console.error('DB Update error:', err));

          io.to(`room:${gamePin}`).emit('question_start', {
            questionIndex: 0,
            questionText: firstQuestion.question,
            options: firstQuestion.options,
            timeLimit: firstQuestion.timeLimit,
            totalQuestions: questions.length,
            backgroundMusic: liveSession.backgroundMusic || 'off'
          });

          // Start countdown timer
          startCountdown(io, gamePin, firstQuestion.timeLimit);
        }, 2000);

      } catch (err: any) {
        emitSocketError(socket, err, 'host_start_game');
      }
    });

    // 3. Host advances to next question
    socket.on('host_next_question', async ({ gamePin }: { gamePin: string }) => {
      try {
        const session = await getActiveSession(gamePin, 'SCOREBOARD');

        if (!session) {
          return socket.emit('error', { message: 'Game session must be showing the scoreboard to advance' });
        }

        if (session.host.toString() !== socket.userId) {
          return socket.emit('error', { message: 'Only the host can advance the game' });
        }

        const quiz = await Quiz.findById(session.quiz);
        if (!quiz) return socket.emit('error', { message: 'Quiz not found' });
        activeQuizzes[gamePin] = quiz;

        const questions = getSessionQuestions(session, quiz);
        const nextIndex = session.currentQuestionIndex + 1;

        if (nextIndex >= questions.length) {
          await finalizeGameSession(io, gamePin, session, questions);
        } else {
          // Next question exists
          session.state = 'QUESTION_ACTIVE';
          session.currentQuestionIndex = nextIndex;
          session.questionActiveSince = new Date();

          GameSession.findByIdAndUpdate(session._id, {
            state: 'QUESTION_ACTIVE',
            currentQuestionIndex: nextIndex,
            questionActiveSince: session.questionActiveSince
          }).catch(err => console.error('DB Update error:', err));

          // Non-blocking — measured: with 100 players' accumulated answers
          // in the payload, this single write was still adding a real and
          // growing delay between questions once awaited, even though it
          // only fires once per question rather than once per player.
          syncSession(gamePin, session);

          const nextQuestion = questions[nextIndex];

          io.to(`room:${gamePin}`).emit('question_start', {
            questionIndex: nextIndex,
            questionText: nextQuestion.question,
            options: nextQuestion.options,
            timeLimit: nextQuestion.timeLimit,
            totalQuestions: questions.length,
            backgroundMusic: session.backgroundMusic || 'off'
          });

          startCountdown(io, gamePin, nextQuestion.timeLimit);
        }
      } catch (err: any) {
        emitSocketError(socket, err, 'host_next_question');
      }
    });

    // 3b. Host closes / aborts the room entirely (Host cancels lobby or clicks Close Room)
    socket.on('host_close_room', async ({ gamePin }: { gamePin: string }) => {
      try {
        const session = await GameSession.findOne({ gamePin });
        if (session) {
          if (!socket.userId || session.host.toString() !== socket.userId) {
            return socket.emit('error', { message: 'Only the host can close this room' });
          }

          if (session.isJackpot && session.state !== 'FINISHED' && session.state !== 'CANCELLED') {
            const reason = session.state === 'LOBBY'
              ? 'Cancelled by admin before start'
              : 'Ended early by admin';
            await cancelAndRefundJackpotRoom(io, { sessionId: String(session._id) }, reason);
            await forceCloseActiveRoom(
              io,
              gamePin,
              'This Jackpot Room was cancelled by the admin. Any entry coins have been automatically refunded to your wallet.'
            );
            console.log(`Admin cancelled Jackpot room:${gamePin} with automatic refunds`);
            return;
          }

          if (!session.isJackpot && session.state !== 'FINISHED') {
            session.state = 'FINISHED';
            session.finishedAt = new Date();
            await session.save();
          }
        }

        await forceCloseActiveRoom(io, gamePin, 'The host has ended this game session.');
        console.log(`Host aborted room:${gamePin}`);
      } catch (err: any) {
        emitSocketError(socket, err, 'host_close_room');
      }
    });

    // --- PLAYER HANDLERS ---

    // 4. Player joins a lobby room
    socket.on('player_join_lobby', async ({ gamePin, nickname, avatar }: { gamePin: string; nickname: string; avatar: string }) => {
      try {
        if (!gamePin || !nickname || !avatar) {
          return socket.emit('error', { message: 'Pin, Nickname, and Avatar are required' });
        }

        // Outside the lock, on purpose (see confirmSocketAlive above): if this
        // nickname currently maps to a socket that LOOKS connected per
        // Socket.IO's cached heartbeat state, actively confirm that in
        // real time before ever taking the room lock. Only runs when the
        // in-memory session is already warm, which it always is for a game
        // that's actually in progress — the only time it's cold is right
        // after a server restart before anyone's touched the room yet.
        const peekSession = activeSessions[gamePin];
        if (peekSession && peekSession.state !== 'LOBBY') {
          const trimmedNickname = nickname.trim().toLowerCase();
          const peekMatch = peekSession.players.find((p: any) => p.nickname.toLowerCase() === trimmedNickname);
          if (peekMatch) {
            const stillAlive = await confirmSocketAlive(io, peekMatch.socketId);
            if (stillAlive) {
              return socket.emit('join_failed', { message: 'Nickname is already taken by an active player in this game.' });
            }
            // Confirmed dead — fall through to the lock below, which
            // re-checks the cheap synchronous flag fresh immediately
            // before committing, in case someone else reclaimed the seat
            // in the moment this probe was in flight.
          }
        }

        // The read-check-modify-write below must be atomic per room: without the
        // lock, two players joining in the same instant could both read the same
        // pre-join state and each write their own version back, silently dropping
        // whichever player's update got overwritten (and letting the room exceed
        // its player cap, since both reads would see it as not-yet-full).
        const result = await withRoomLock(gamePin, async () => {
          // Not scoped to LOBBY here — an active game must still be found so
          // a returning player (matched below) can rejoin after the server
          // cache is cold (e.g. a restart mid-game), not just while warm.
          const session = await getActiveSession(gamePin);

          if (!session) {
            return { status: 'error' as const, message: 'Active game lobby not found. Check the Game Pin.' };
          }

          // Jackpot rooms require atomic coin payment via POST /api/jackpot/:id/join.
          // Block unpaid / anonymous PIN joins; allow already-paid authenticated
          // players to bind their socket and enter cleanly.
          if (session.isJackpot) {
            if (!socket.userId) {
              return { status: 'join_failed' as const, message: 'Please sign in and join this Jackpot Room from the Jackpot Live card.' };
            }
            const paidPlayer = session.players.find(
              (p: any) => p.userId && String(p.userId) === String(socket.userId)
            );
            if (!paidPlayer) {
              return { status: 'join_failed' as const, message: 'Entry payment is required. Join this room from the Jackpot Live card.' };
            }

            if (paidPlayer.socketId && paidPlayer.socketId !== socket.id) {
              const currentSocket = io.sockets.sockets.get(paidPlayer.socketId);
              if (currentSocket && currentSocket.connected) {
                return { status: 'join_failed' as const, message: 'You are already connected to this Jackpot Room in another tab.' };
              }
            }

            paidPlayer.socketId = socket.id;
            GameSession.updateOne(
              { _id: session._id, 'players.userId': socket.userId },
              { $set: { 'players.$.socketId': socket.id } }
            ).catch((err: any) => console.error('DB Jackpot Bind Socket error:', err));
            syncSession(gamePin, session);

            if (session.state === 'LOBBY') {
              return {
                status: 'ok' as const,
                newPlayer: paidPlayer,
                players: session.players,
                chatEnabled: session.chatEnabled !== false,
                chatMessages: session.chatMessages || []
              };
            }
            return { status: 'rejoined' as const, session };
          }

          // A matching nickname already in this room means this is the same
          // player reconnecting (lost wifi, closed the tab, switched device)
          // rather than a brand-new join — let them back in regardless of
          // how far the game has progressed, instead of flatly rejecting
          // once it's moved past the lobby.
          const existingPlayer = session.players.find((p: any) => p.nickname.toLowerCase() === nickname.trim().toLowerCase());
          if (existingPlayer) {
            if (session.state === 'LOBBY') {
              // Still pre-game: a name "slot" isn't claimed to a specific
              // person yet, so two different people typing the same name
              // is a real collision, not an assumed reconnect.
              return { status: 'join_failed' as const, message: 'Nickname is already taken. Try another!' };
            }

            // Security-critical: a nickname can only be reclaimed if that
            // player's connection is genuinely dead. Without this check,
            // anyone who knows the game pin could type an active player's
            // nickname and hijack their seat mid-game — their socketId
            // would get silently overwritten here, and the real player's
            // next answer submission would fail since it's matched by
            // socket.id. A live, connected player's seat is never
            // reclaimable by someone else, full stop.
            const currentSocket = io.sockets.sockets.get(existingPlayer.socketId);
            if (currentSocket && currentSocket.connected) {
              return { status: 'join_failed' as const, message: 'Nickname is already taken by an active player in this game.' };
            }

            existingPlayer.socketId = socket.id;
            GameSession.updateOne(
              { _id: session._id, 'players.nickname': existingPlayer.nickname },
              { $set: { 'players.$.socketId': socket.id } }
            ).catch((err: any) => console.error('DB Rejoin Update error:', err));
            syncSession(gamePin, session);

            return { status: 'rejoined' as const, session };
          }

          if (session.state !== 'LOBBY') {
            return { status: 'error' as const, message: 'This game has already started. Only returning players can rejoin.' };
          }

          // Check player count against host's playerLimit tier
          const limit = session.playerLimit || 10;
          if (session.players.length >= limit) {
            return { status: 'join_failed' as const, message: `This game lobby is full! The maximum cap for this session is ${limit} players.` };
          }

          const newPlayer = {
            socketId: socket.id,
            nickname: nickname.trim(),
            avatar,
            score: 0,
            answers: [],
            joinedAt: new Date()
          };

          session.players.push(newPlayer);

          // Update MongoDB in background
          GameSession.findByIdAndUpdate(session._id, {
            $push: { players: newPlayer }
          }).catch((err: any) => console.error('DB Update error:', err));

          // Update in-memory cache immediately, checkpoint Redis in the
          // background — not awaited, so a burst of 100 players joining at
          // once doesn't serialize 100 blocking round-trips to Redis one
          // after another (measured: that alone took up to a minute).
          syncSession(gamePin, session);

          return {
            status: 'ok' as const,
            newPlayer,
            players: session.players,
            chatEnabled: session.chatEnabled !== false,
            chatMessages: session.chatMessages || []
          };
        });

        if (result.status === 'error') {
          return socket.emit('error', { message: result.message });
        }
        if (result.status === 'join_failed') {
          return socket.emit('join_failed', { message: result.message });
        }

        if (result.status === 'rejoined') {
          const { session } = result;
          socket.join(`room:${gamePin}`);
          console.log(`Player ${nickname} rejoined mid-game room:${gamePin} with socket ${socket.id}`);

          const roomState = await getRoomStateSnapshot(session, gamePin);
          const rejoinedPlayer = session.players.find((p: any) => p.socketId === socket.id);
          socket.emit('rejoin_success', {
            roomState,
            player: { nickname: rejoinedPlayer.nickname, avatar: rejoinedPlayer.avatar }
          });

          io.to(`room:${gamePin}`).emit('lobby_update', {
            players: session.players.map((p: any) => ({ nickname: p.nickname, avatar: p.avatar }))
          });
          return;
        }

        const { newPlayer, players, chatEnabled, chatMessages } = result;
        socket.join(`room:${gamePin}`);
        console.log(`Player ${nickname} joined room:${gamePin}`);

        const playersList = players.map((p: any) => ({
          nickname: p.nickname,
          avatar: p.avatar
        }));

        // Confirm join success and return players list to eliminate join race conditions
        socket.emit('join_success', {
          gamePin,
          nickname: newPlayer.nickname,
          avatar: newPlayer.avatar,
          players: playersList,
          chatEnabled,
          chatMessages
        });

        // Broadcast updated players list to room
        io.to(`room:${gamePin}`).emit('lobby_update', {
          players: playersList
        });
      } catch (err: any) {
        emitSocketError(socket, err, 'player_join_lobby');
      }
    });

    // Host manually removes a player from the lobby — e.g. a duplicate/ghost
    // entry left behind by a flaky connection, or someone who's clearly gone.
    // Scoped to LOBBY only for now: mid-game removal would need to touch
    // scoring/leaderboard logic and isn't handled here.
    socket.on('host_remove_player', async ({ gamePin, nickname }: { gamePin: string; nickname: string }) => {
      try {
        const result = await withRoomLock(gamePin, async () => {
          const session = await getActiveSession(gamePin, 'LOBBY');

          if (!session) {
            return { status: 'error' as const, message: 'Game session not found' };
          }
          if (session.host.toString() !== socket.userId) {
            return { status: 'error' as const, message: 'Only the host can remove players' };
          }
          if (session.state !== 'LOBBY') {
            return { status: 'error' as const, message: 'Players can only be removed while the lobby is open' };
          }

          const playerIndex = session.players.findIndex((p: any) => p.nickname === nickname);
          if (playerIndex === -1) {
            return { status: 'error' as const, message: 'Player not found in this session' };
          }

          const [removedPlayer] = session.players.splice(playerIndex, 1);

          GameSession.updateOne(
            { _id: session._id },
            { $pull: { players: { nickname } } }
          ).catch((err: any) => console.error('DB Update error:', err));

          if (session.isJackpot && session.jackpot && session.jackpot.paidSeatsCount > 0) {
            session.jackpot.paidSeatsCount = Math.max(0, session.jackpot.paidSeatsCount - 1);
          }

          syncSession(gamePin, session);

          return {
            status: 'ok' as const,
            removedPlayer,
            players: session.players,
            isJackpot: !!session.isJackpot,
            sessionId: String(session._id),
            jackpotTitle: session.jackpot?.title || 'Jackpot Room'
          };
        });

        if (result.status === 'error') {
          return socket.emit('error', { message: result.message });
        }

        // If this was a Jackpot Room, automatically refund the removed player's coins
        let refundedCoins = 0;
        if (result.isJackpot && result.removedPlayer.userId) {
          const refundRes = await refundSingleJackpotEntry(
            io,
            result.sessionId,
            String(result.removedPlayer.userId),
            result.jackpotTitle,
            'Removed from lobby by admin'
          );
          refundedCoins = refundRes.coinsRefunded;
          emitJackpotLiveUpdate(io);
        }

        // Disconnect the removed player's own socket from the room and notify them
        const removedSocketId = result.removedPlayer.socketId;
        if (removedSocketId) {
          const removedSocket = io.sockets.sockets.get(removedSocketId);
          if (removedSocket) {
            removedSocket.emit('removed_from_game', {
              message: refundedCoins > 0
                ? `The admin removed you from this Jackpot Room. Your ${refundedCoins} coins have been refunded.`
                : 'The host has removed you from this game session.'
            });
            removedSocket.leave(`room:${gamePin}`);
          }
        }

        // Broadcast updated player list to remaining room members
        io.to(`room:${gamePin}`).emit('lobby_update', {
          players: result.players.map((p: any) => ({ nickname: p.nickname, avatar: p.avatar }))
        });

        console.log(`Host removed player "${nickname}" from room:${gamePin}`);
      } catch (err: any) {
        emitSocketError(socket, err, 'host_remove_player');
      }
    });

    // --- IN-GAME CHAT ---
    // Not wrapped in withRoomLock: this only ever reads `session` (sender
    // lookup, mute/enabled checks), never mutates it, so there's no
    // read-modify-write race to guard against — and keeping it lock-free
    // means a flood of chat messages can never queue up behind, or in
    // front of, the answer-submission lock that actually needs it.

    // Host turns the room's chat on/off — can be changed from the lobby or
    // mid-game, not just before starting.
    socket.on('host_toggle_chat', async ({ gamePin, enabled }: { gamePin: string; enabled: boolean }) => {
      try {
        const session = await getActiveSession(gamePin);
        if (!session) return socket.emit('chat_error', { message: 'Game session not found' });
        if (!socket.userId || session.host?.toString() !== socket.userId) {
          return socket.emit('chat_error', { message: 'Only the host can change chat settings' });
        }

        session.chatEnabled = !!enabled;
        GameSession.updateOne({ _id: session._id }, { chatEnabled: session.chatEnabled })
          .catch((err: any) => console.error('DB Update error:', err));
        syncSession(gamePin, session);

        io.to(`room:${gamePin}`).emit('chat_toggled', { chatEnabled: session.chatEnabled });
      } catch (err: any) {
        emitSocketError(socket, err, 'host_toggle_chat');
      }
    });

    const setPlayerChatMute = async (
      socket: AuthenticatedSocket,
      gamePin: string,
      nickname: string,
      muted: boolean
    ) => {
      const session = await getActiveSession(gamePin);
      if (!session) return socket.emit('chat_error', { message: 'Game session not found' });
      if (!socket.userId || session.host?.toString() !== socket.userId) {
        return socket.emit('chat_error', { message: 'Only the host can mute or unmute players' });
      }
      const player = session.players.find((p: any) => p.nickname === nickname);
      if (!player) return socket.emit('chat_error', { message: 'Player not found in this session' });

      player.mutedInChat = muted;
      GameSession.updateOne(
        { _id: session._id, 'players.nickname': nickname },
        { $set: { 'players.$.mutedInChat': muted } }
      ).catch((err: any) => console.error('DB Update error:', err));
      syncSession(gamePin, session);

      if (player.socketId) {
        io.sockets.sockets.get(player.socketId)?.emit('chat_mute_status', { muted });
      }
      io.to(`room:${gamePin}`).emit('player_mute_changed', { nickname, muted });
    };

    socket.on('host_mute_player', ({ gamePin, nickname }: { gamePin: string; nickname: string }) => {
      setPlayerChatMute(socket, gamePin, nickname, true).catch((err) => emitSocketError(socket, err, 'host_mute_player'));
    });

    socket.on('host_unmute_player', ({ gamePin, nickname }: { gamePin: string; nickname: string }) => {
      setPlayerChatMute(socket, gamePin, nickname, false).catch((err) => emitSocketError(socket, err, 'host_unmute_player'));
    });

    // Any player or the host sends a chat message
    socket.on('chat_message', async ({ gamePin, text }: { gamePin: string; text: string }) => {
      try {
        const session = await getActiveSession(gamePin);
        if (!session) return;

        if (session.chatEnabled === false) {
          return socket.emit('chat_error', { message: 'Chat is disabled for this game.' });
        }

        const validationError = validateChatMessage(text);
        if (validationError) {
          return socket.emit('chat_error', { message: validationError });
        }

        if (isChatRateLimited(socket.id)) {
          return socket.emit('chat_error', { message: 'You are sending messages too quickly. Please slow down.' });
        }

        let senderNickname: string;
        let senderAvatar: string | null = null;
        let isHost = false;

        if (socket.userId && session.host?.toString() === socket.userId) {
          isHost = true;
          senderNickname = session.hostDisplayName || 'Host';
        } else {
          const player = session.players.find((p: any) => p.socketId === socket.id);
          if (!player) {
            return socket.emit('chat_error', { message: 'You are not part of this game session.' });
          }
          if (player.mutedInChat) {
            return socket.emit('chat_error', { message: 'You have been muted by the host and cannot send messages.' });
          }
          senderNickname = player.nickname;
          senderAvatar = player.avatar;
        }

        const chatMessage = {
          nickname: senderNickname,
          avatar: senderAvatar,
          isHost,
          text: censorMessage(text.trim()),
          timestamp: Date.now()
        };

        // Kept in-memory only (never written to Mongo — see the schema
        // comment on chatEnabled) so a genuine reconnect (new tab, new
        // device, cleared storage — not just navigating between the lobby
        // and game-room screens, which the client's own chat store already
        // handles) can still catch up on what it missed. This naturally
        // disappears the moment the room itself closes, since that's
        // exactly when clearRoomMemory deletes this whole session object.
        if (!Array.isArray(session.chatMessages)) session.chatMessages = [];
        session.chatMessages.push(chatMessage);
        if (session.chatMessages.length > 100) session.chatMessages.shift();
        syncSession(gamePin, session);

        io.to(`room:${gamePin}`).emit('chat_message_received', chatMessage);
      } catch (err: any) {
        emitSocketError(socket, err, 'chat_message');
      }
    });

    // Helper to construct snapshot of active game room state for rejoining clients
    const getRoomStateSnapshot = async (session: any, gamePin: string) => {
      let quiz = activeQuizzes[gamePin];
      if (!quiz) {
        quiz = await Quiz.findById(session.quiz);
        if (quiz) activeQuizzes[gamePin] = quiz;
      }
      const questions = getSessionQuestions(session, quiz);
      let activeQuestionData = null;
      let secondsRemaining = 0;

      if (session.state === 'QUESTION_ACTIVE' && questions.length > 0) {
        const currentQuestion = questions[session.currentQuestionIndex];
        if (currentQuestion) {
          const timePassedMs = Math.max(0, new Date().getTime() - new Date(session.questionActiveSince).getTime());
          secondsRemaining = Math.max(0, currentQuestion.timeLimit - Math.floor(timePassedMs / 1000));
          activeQuestionData = {
            questionIndex: session.currentQuestionIndex,
            questionText: currentQuestion.question,
            options: currentQuestion.options,
            timeLimit: currentQuestion.timeLimit,
            totalQuestions: questions.length
          };
        }
      }

      const mappedLeaderboard = session.isJackpot
        ? rankJackpotPlayers(session.players, questions).map((entry, idx) => ({
            rank: idx + 1,
            nickname: entry.player.nickname,
            avatar: entry.player.avatar,
            score: entry.score,
            totalAnswerTimeMs: entry.totalAnswerTimeMs,
            finishedAt: entry.finishedAt,
            isCorrect: entry.player.answers.find((ans: any) => ans.questionIndex === session.currentQuestionIndex)?.isCorrect || false
          }))
        : [...session.players].sort((a, b) => b.score - a.score).map((p: any, idx) => ({
            rank: idx + 1,
            nickname: p.nickname,
            avatar: p.avatar,
            score: p.score,
            isCorrect: p.answers.find((ans: any) => ans.questionIndex === session.currentQuestionIndex)?.isCorrect || false
          }));

      return {
        state: session.state,
        currentQuestionIndex: session.currentQuestionIndex,
        secondsRemaining,
        totalQuestions: questions.length,
        quizTitle: session.isJackpot ? (session.jackpot?.title || quiz?.title || '') : (quiz ? quiz.title : ''),
        playerLimit: session.playerLimit || 10,
        lobbyMusic: session.lobbyMusic || 'off',
        players: session.players.map((p: any) => ({ nickname: p.nickname, avatar: p.avatar, mutedInChat: !!p.mutedInChat })),
        activeQuestion: activeQuestionData,
        leaderboard: mappedLeaderboard,
        chatEnabled: session.chatEnabled !== false,
        chatMessages: session.chatMessages || [],
        isJackpot: !!session.isJackpot,
        jackpot: session.isJackpot && session.jackpot
          ? {
              id: String(session._id),
              title: session.jackpot.title,
              prizeLabel: session.jackpot.prizeLabel,
              entryCostCoins: session.jackpot.entryCostCoins,
              playerLimit: session.playerLimit
            }
          : null
      };
    };

    // 4b. Host re-joins after page refresh/reconnect
    socket.on('host_rejoin', async ({ gamePin }: { gamePin: string }) => {
      try {
        const session = await getActiveSession(gamePin);
        if (!session) return;

        socket.join(`room:${gamePin}`);
        console.log(`Host re-joined room:${gamePin}`);

        const roomState = await getRoomStateSnapshot(session, gamePin);
        socket.emit('rejoin_success', { roomState });
      } catch (e) {
        console.error('Host rejoin error:', e);
      }
    });

    // 4c. Player re-joins after page refresh/reconnect. Lock-protected like
    // join/submit-answer — a burst of reconnects (e.g. flaky venue wifi
    // dropping many phones at once) mutates the same in-memory players
    // array and needs the same serialization guarantee.
    socket.on('player_rejoin', async ({ gamePin, nickname }: { gamePin: string; nickname: string }) => {
      try {
        // Same outside-the-lock real-time probe as player_join_lobby, for
        // the same reason: a 2.5s wait must never happen while holding
        // withRoomLock.
        const peekSession = activeSessions[gamePin];
        if (peekSession) {
          const trimmedNickname = (nickname || '').toLowerCase().trim();
          const peekMatch = peekSession.isJackpot && socket.userId
            ? peekSession.players.find((p: any) => p.userId && String(p.userId) === String(socket.userId))
            : peekSession.players.find((p: any) => p.nickname.toLowerCase() === trimmedNickname);
          if (peekMatch && peekMatch.socketId && peekMatch.socketId !== socket.id) {
            const stillAlive = await confirmSocketAlive(io, peekMatch.socketId);
            if (stillAlive) return; // same as today: a live nickname collision is treated as "not found"
          }
        }

        const player = await withRoomLock(gamePin, async () => {
          const session = await getActiveSession(gamePin);
          if (!session) return null;

          let match: any = null;
          if (session.isJackpot) {
            // Jackpot seats are strictly bound to authenticated userId — prevents seat hijacking
            if (!socket.userId) return null;
            match = session.players.find(
              (p: any) => p.userId && String(p.userId) === String(socket.userId)
            );
          } else {
            match = session.players.find((p: any) => p.nickname.toLowerCase() === (nickname || '').toLowerCase().trim());
          }
          if (!match) return null;

          // Same hijack guard as player_join_lobby: never let a nickname be
          // reclaimed while that player's own connection is still live.
          if (match.socketId && match.socketId !== socket.id) {
            const currentSocket = io.sockets.sockets.get(match.socketId);
            if (currentSocket && currentSocket.connected) return null;
          }

          match.socketId = socket.id;

          const updateQuery = session.isJackpot && match.userId
            ? { _id: session._id, 'players.userId': match.userId }
            : { _id: session._id, 'players.nickname': match.nickname };

          GameSession.updateOne(
            updateQuery,
            { $set: { 'players.$.socketId': socket.id } }
          ).catch(err => console.error('DB Rejoin Update error:', err));

          syncSession(gamePin, session);

          return { nickname: match.nickname, avatar: match.avatar, session };
        });

        if (!player) return;

        socket.join(`room:${gamePin}`);
        console.log(`Player ${nickname} re-joined room:${gamePin} with socket ${socket.id}`);

        const roomState = await getRoomStateSnapshot(player.session, gamePin);
        socket.emit('rejoin_success', {
          roomState,
          player: {
            nickname: player.nickname,
            avatar: player.avatar
          }
        });

        io.to(`room:${gamePin}`).emit('lobby_update', {
          players: player.session.players.map((p: any) => ({
            nickname: p.nickname,
            avatar: p.avatar
          }))
        });
      } catch (e) {
        console.error('Player rejoin error:', e);
      }
    });

    // 5. Player submits an answer
    socket.on('player_submit_answer', async ({ gamePin, selectedAnswer }: { gamePin: string; selectedAnswer: string }) => {
      try {
        // Same read-modify-write hazard as player_join_lobby: without the lock,
        // two players answering in the same instant could both read the same
        // pre-answer cached session and each write their own version back,
        // silently dropping whichever player's answer/score got overwritten
        // from the live leaderboard cache (Mongo stays correct via $inc/$push,
        // but the in-memory room state used to broadcast the scoreboard would not).
        const result = await withRoomLock(gamePin, async () => {
          const session = await getActiveSession(gamePin, 'QUESTION_ACTIVE');

          if (!session || session.state !== 'QUESTION_ACTIVE') {
            return { status: 'error' as const, message: 'Game is not accepting answers right now' };
          }

          const player = session.isJackpot && socket.userId
            ? session.players.find((p: any) => p.socketId === socket.id && String(p.userId) === String(socket.userId))
            : session.players.find((p: any) => p.socketId === socket.id);
          if (!player) {
            return { status: 'error' as const, message: 'Player record not found in session' };
          }

          const alreadyAnswered = player.answers.some((ans: any) => ans.questionIndex === session.currentQuestionIndex);
          if (alreadyAnswered) {
            return { status: 'error' as const, message: 'Answer already submitted' };
          }

          // Read from the in-memory quiz cache instead of hitting Mongo on every
          // single answer — this runs inside the per-room lock, so a DB round-trip
          // here would be paid once per player, serially, for every simultaneous
          // answer burst. Fall back to a fresh fetch only if the cache was never
          // populated (e.g. server restarted mid-game).
          let quiz = activeQuizzes[gamePin];
          if (!quiz && !session.randomizedQuestions?.length) {
            quiz = await Quiz.findById(session.quiz);
            if (!quiz) return { status: 'error' as const, message: 'Quiz not found' };
            activeQuizzes[gamePin] = quiz;
          }

          const questions = getSessionQuestions(session, quiz);
          const currentQuestion = questions[session.currentQuestionIndex];
          if (!currentQuestion) {
            return { status: 'error' as const, message: 'Active question not found' };
          }

          // Server-side validation: answer must be one of the question's actual options
          if (typeof selectedAnswer !== 'string' || !currentQuestion.options.includes(selectedAnswer)) {
            return { status: 'error' as const, message: 'Invalid answer option selected' };
          }

          const now = new Date();
          const rawTimeTakenMs = now.getTime() - new Date(session.questionActiveSince).getTime();
          const timeLimitMs = currentQuestion.timeLimit * 1000;

          // Server-side timer validation (small 750ms grace for network latency)
          if (rawTimeTakenMs > timeLimitMs + 750) {
            return { status: 'error' as const, message: 'Time is up for this question' };
          }

          const timeTakenMs = Math.max(0, Math.min(rawTimeTakenMs, timeLimitMs));
          const isCorrect = (selectedAnswer === currentQuestion.correctOption);

          let scoreAwarded = 0;
          if (isCorrect) {
            const ratio = Math.min(timeTakenMs / timeLimitMs, 1.0);
            scoreAwarded = Math.round(100 * (1 - ratio * 0.5));
          }

          const answerLog = {
            questionIndex: session.currentQuestionIndex,
            selectedAnswer,
            isCorrect,
            scoreAwarded,
            timeTakenMs,
            submittedAt: now
          };

          player.answers.push(answerLog);
          player.score += scoreAwarded;
          player.totalAnswerTimeMs = (player.totalAnswerTimeMs || 0) + timeTakenMs;
          player.lastAnswerAt = now;

          const playerMatchQuery = session.isJackpot && player.userId
            ? { _id: session._id, 'players.userId': player.userId }
            : { _id: session._id, 'players.socketId': socket.id };

          GameSession.updateOne(
            playerMatchQuery,
            {
              $push: { 'players.$.answers': answerLog },
              $inc: {
                'players.$.score': scoreAwarded,
                'players.$.totalAnswerTimeMs': timeTakenMs
              },
              $set: { 'players.$.lastAnswerAt': now }
            }
          ).catch(err => console.error('DB Update error:', err));

          // No Redis write here on purpose. The in-memory activeSessions cache
          // is authoritative for every read in this process, and endQuestion /
          // host_next_question already checkpoint to Redis once per question.
          // Syncing on every single answer used to fire up to 100 full-session
          // (and growing) writes per question at remote Upstash — non-blocking,
          // so they queued up in ioredis faster than the network could drain
          // them and OOM-crashed the process under 100-player load.

          const activeSocketsInRoom = io.sockets.adapter.rooms.get(`room:${gamePin}`);
          const playerSockets = session.players.map((p: any) => p.socketId);
          const joinedPlayerSocketsInRoom = Array.from(activeSocketsInRoom || []).filter(sid => playerSockets.includes(sid));

          const answeredCount = session.players.filter((p: any) =>
            p.socketId && joinedPlayerSocketsInRoom.includes(p.socketId) &&
            p.answers.some((ans: any) => ans.questionIndex === session.currentQuestionIndex)
          ).length;

          const allAnswered = answeredCount >= joinedPlayerSocketsInRoom.length && joinedPlayerSocketsInRoom.length > 0;

          return { status: 'ok' as const, isCorrect, scoreAwarded, totalScore: player.score, allAnswered };
        });

        if (result.status === 'error') {
          return socket.emit('error', { message: result.message });
        }

        socket.emit('answer_received', { isCorrect: result.isCorrect, scoreAwarded: result.scoreAwarded, totalScore: result.totalScore });

        if (result.allAnswered) {
          console.log(`All players in room:${gamePin} answered. Ending question early.`);
          clearTimeout(activeTimers[gamePin]);
          endQuestion(io, gamePin);
        }
      } catch (err: any) {
        emitSocketError(socket, err, 'player_submit_answer');
      }
    });

    // 6. Handle client disconnect (Survives refreshes - player is not auto-evicted)
    socket.on('disconnect', async () => {
      console.log('Client socket disconnected:', socket.id);
      clearChatRateLimit(socket.id);
    });
  });
};

const startCountdown = (io: Server, gamePin: string, durationSeconds: number) => {
  if (activeTimers[gamePin]) {
    clearTimeout(activeTimers[gamePin]);
  }

  let secondsLeft = durationSeconds;

  const tick = () => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      endQuestion(io, gamePin);
    } else {
      io.to(`room:${gamePin}`).emit('timer_tick', { secondsRemaining: secondsLeft });
      activeTimers[gamePin] = setTimeout(tick, 1000);
    }
  };

  activeTimers[gamePin] = setTimeout(tick, 1000);
};

// Shared game completion helper for both endQuestion (last question) and
// host_next_question. For Jackpot rooms, computes tie-broken Top 5 winners,
// persists them durably, broadcasts public winners to the room, and sends
// the full payout contact list (name/email/phone) privately to the admin host.
const finalizeGameSession = async (io: Server, gamePin: string, session: any, questions: any[]) => {
  session.state = 'FINISHED';
  session.finishedAt = new Date();

  if (session.isJackpot) {
    const ranked = rankJackpotPlayers(session.players || [], questions);
    const winners = await buildTop5Winners(session, questions);

    await GameSession.findByIdAndUpdate(session._id, {
      $set: {
        state: 'FINISHED',
        finishedAt: session.finishedAt,
        'jackpot.winners': winners
      }
    }).catch(err => console.error('DB Jackpot Finalize error:', err));

    await delRoomCache(gamePin);
    clearRoomMemory(gamePin);

    const publicLeaderboard = ranked.map((entry, idx) => ({
      rank: idx + 1,
      nickname: entry.player.nickname,
      avatar: entry.player.avatar,
      score: entry.score,
      totalAnswerTimeMs: entry.totalAnswerTimeMs,
      finishedAt: entry.finishedAt
    }));

    const publicWinners = winners.map((w) => ({
      rank: w.rank,
      nickname: w.nickname,
      avatar: w.avatar,
      score: w.score,
      totalAnswerTimeMs: w.totalAnswerTimeMs,
      finishedAt: w.finishedAt
    }));

    io.to(`room:${gamePin}`).emit('game_over', {
      isJackpot: true,
      jackpot: session.jackpot
        ? {
            id: String(session._id),
            title: session.jackpot.title,
            prizeLabel: session.jackpot.prizeLabel,
            entryCostCoins: session.jackpot.entryCostCoins
          }
        : null,
      winners: publicWinners,
      leaderboard: publicLeaderboard
    });

    // Send full Top 5 payout contacts (name, email, phone) to the hosting
    // Jackpot Admin / Super Admin so they can call & pay the winners immediately.
    const hostDoc = await User.findById(session.host).select('isAdmin isSuperAdmin');
    if (hostDoc?.isAdmin || hostDoc?.isSuperAdmin) {
      io.to(`user:${String(session.host)}`).emit('jackpot_admin_winners', {
        sessionId: String(session._id),
        gamePin,
        title: session.jackpot?.title || '',
        prizeLabel: session.jackpot?.prizeLabel || '',
        winners
      });
    }

    // Notify Top 5 winners via ZeptoMail asynchronously (non-blocking)
    notifyJackpotWinnersByEmail(
      session.jackpot?.title || 'Jackpot Room',
      session.jackpot?.prizeLabel || 'Jackpot Prize',
      winners
    );

    emitJackpotLiveUpdate(io);
    return;
  }

  GameSession.findByIdAndUpdate(session._id, {
    state: 'FINISHED',
    finishedAt: session.finishedAt
  }).catch(err => console.error('DB Update error:', err));

  await delRoomCache(gamePin);
  clearRoomMemory(gamePin);

  const finalLeaderboard = [...session.players].sort((a, b) => b.score - a.score);

  io.to(`room:${gamePin}`).emit('game_over', {
    leaderboard: finalLeaderboard.map((p, idx) => ({
      rank: idx + 1,
      nickname: p.nickname,
      avatar: p.avatar,
      score: p.score
    }))
  });
};

const endQuestion = async (io: Server, gamePin: string) => {
  delete activeTimers[gamePin];

  try {
    // Wrapped in the same per-room lock as player_submit_answer so a
    // timer expiring at the exact instant the last player answers (both
    // paths call endQuestion) can't run concurrently and double-broadcast.
    // The QUESTION_ACTIVE guard below makes a second, queued-up call a safe
    // no-op once the first call has already transitioned the room's state.
    await withRoomLock(gamePin, async () => {
      const session = await getActiveSession(gamePin, 'QUESTION_ACTIVE');

      if (!session || session.state !== 'QUESTION_ACTIVE') return;

      let quiz = activeQuizzes[gamePin];
      if (!quiz && !session.randomizedQuestions?.length) {
        quiz = await Quiz.findById(session.quiz);
        if (!quiz) return;
        activeQuizzes[gamePin] = quiz;
      }

      const questions = getSessionQuestions(session, quiz);
      const currentQuestion = questions[session.currentQuestionIndex];
      if (!currentQuestion) return;

      const isLastQuestion = (session.currentQuestionIndex + 1 >= questions.length);

      if (isLastQuestion) {
        await finalizeGameSession(io, gamePin, session, questions);
      } else {
        session.state = 'SCOREBOARD';

        // Update DB in background
        GameSession.findByIdAndUpdate(session._id, { state: 'SCOREBOARD' }).catch(err => console.error('DB Update error:', err));

        // Update cache
        syncSession(gamePin, session);

        const leaderboardPayload = session.isJackpot
          ? rankJackpotPlayers(session.players, questions).map((entry, idx) => ({
              rank: idx + 1,
              nickname: entry.player.nickname,
              avatar: entry.player.avatar,
              score: entry.score,
              totalAnswerTimeMs: entry.totalAnswerTimeMs,
              isCorrect: entry.player.answers.find((ans: any) => ans.questionIndex === session.currentQuestionIndex)?.isCorrect || false
            }))
          : [...session.players].sort((a, b) => b.score - a.score).map((p: any, idx) => ({
              rank: idx + 1,
              nickname: p.nickname,
              avatar: p.avatar,
              score: p.score,
              isCorrect: p.answers.find((ans: any) => ans.questionIndex === session.currentQuestionIndex)?.isCorrect || false
            }));

        io.to(`room:${gamePin}`).emit('question_ended', {
          correctOption: currentQuestion.correctOption,
          leaderboard: leaderboardPayload
        });
      }
    });
  } catch (err) {
    console.error('Error ending question:', err);
  }
};
