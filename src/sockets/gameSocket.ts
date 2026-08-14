import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { Quiz } from '../models/Quiz';
import { User } from '../models/User';
import { getGlobalConfig } from '../models/AppConfig';
import { GameSession } from '../models/GameSession';
import { WalletTransaction } from '../models/WalletTransaction';
import { setRoomCache, getRoomCache, delRoomCache, withRoomLock } from '../services/redisService';
import { env } from '../config/env';

const JWT_SECRET = env.JWT_SECRET;

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

// Track active timers by game pin
const activeTimers: { [gamePin: string]: NodeJS.Timeout } = {};

// In-memory cache of each active room's quiz document. player_submit_answer
// runs inside a per-room lock (see withRoomLock) that serializes concurrent
// answers, so any awaited work inside it directly multiplies into the queue
// depth — re-fetching the quiz from Mongo on every single answer would mean
// 50 simultaneous answers pay 50 serialized Atlas round-trips back to back.
// The quiz never changes mid-game, so it's fetched once and reused.
const activeQuizzes: { [gamePin: string]: any } = {};

export const setupGameSockets = (io: Server) => {
  // Socket auth middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
        socket.userId = decoded.id;
        socket.userEmail = decoded.email;
      } catch (err) {
        console.log('Socket connection without auth token validation:', socket.id);
      }
    }
    next();
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log('Client connected:', socket.id);

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
        let existingSession = await GameSession.findOne({ gamePin, state: { $ne: 'FINISHED' } });
        while (existingSession) {
          gamePin = Math.floor(100000 + Math.random() * 900000).toString();
          existingSession = await GameSession.findOne({ gamePin, state: { $ne: 'FINISHED' } });
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
          await WalletTransaction.create({
            user: socket.userId,
            type: 'host_game',
            coinsChange: -coinCost,
            amountMoney: 0,
            description: `Hosted game session for "${quiz.title}" (${playerLimit} players)`,
            status: 'completed'
          });
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

        const sessionObj = session.toObject();
        // Seed cache
        await setRoomCache(gamePin, sessionObj);
        activeQuizzes[gamePin] = quiz;

        socket.join(`room:${gamePin}`);
        console.log(`Host created lobby room:${gamePin} (Limit: ${playerLimit}, Coins spent: ${coinCost})`);

        socket.emit('lobby_created', {
          gamePin,
          quizTitle: quiz.title,
          totalQuestions: quiz.questions.length,
          playerLimit,
          coinsDeducted: coinCost,
          remainingCoins: user.coins
        });
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // Host changes lobby background music
    socket.on('host_change_lobby_music', async ({ gamePin, lobbyMusic }: { gamePin: string; lobbyMusic: string }) => {
      try {
        let session = await getRoomCache(gamePin);
        if (!session) {
          const dbSession = await GameSession.findOne({ gamePin });
          if (dbSession) session = dbSession.toObject();
        }
        if (!session) return;

        session.lobbyMusic = lobbyMusic;
        await setRoomCache(gamePin, session);

        // Broadcast to all players in the lobby room
        io.to(`room:${gamePin}`).emit('lobby_music_changed', { lobbyMusic });
      } catch (e) {
        console.error('Change lobby music error:', e);
      }
    });

    // 2. Host starts the game
    socket.on('host_start_game', async ({ gamePin, backgroundMusic }: { gamePin: string; backgroundMusic?: string }) => {
      try {
        // Read from Cache first, fall back to DB
        let session = await getRoomCache(gamePin);
        if (!session) {
          session = await GameSession.findOne({ gamePin, state: 'LOBBY' });
          if (session) session = session.toObject();
        }

        if (!session) {
          return socket.emit('error', { message: 'Lobby not found or already started' });
        }

        if (session.host.toString() !== socket.userId) {
          return socket.emit('error', { message: 'Only the host can start this game' });
        }

        // Set state to active
        session.state = 'QUESTION_ACTIVE';
        session.currentQuestionIndex = 0;
        session.questionActiveSince = new Date();
        session.backgroundMusic = backgroundMusic || 'off';

        // Update database in background
        GameSession.findByIdAndUpdate(session._id, {
          state: 'QUESTION_ACTIVE',
          currentQuestionIndex: 0,
          questionActiveSince: session.questionActiveSince,
          backgroundMusic: session.backgroundMusic
        }).catch(err => console.error('DB Update error:', err));

        // Update cache
        await setRoomCache(gamePin, session);

        const quiz = await Quiz.findById(session.quiz);
        if (!quiz || quiz.questions.length === 0) {
          return socket.emit('error', { message: 'Quiz questions not found' });
        }
        activeQuizzes[gamePin] = quiz;

        const firstQuestion = quiz.questions[0];

        // Broadcast to room that the game has started
        io.to(`room:${gamePin}`).emit('game_started');

        // Delay emitting the first question by 2000ms to allow client-side page routing to mount GameRoom
        setTimeout(() => {
          io.to(`room:${gamePin}`).emit('question_start', {
            questionIndex: 0,
            questionText: firstQuestion.question,
            options: firstQuestion.options,
            timeLimit: firstQuestion.timeLimit,
            totalQuestions: quiz.questions.length,
            backgroundMusic: session.backgroundMusic || 'off'
          });

          // Start countdown timer
          startCountdown(io, gamePin, firstQuestion.timeLimit);
        }, 2000);

      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // 3. Host advances to next question
    socket.on('host_next_question', async ({ gamePin }: { gamePin: string }) => {
      try {
        let session = await getRoomCache(gamePin);
        if (!session) {
          session = await GameSession.findOne({ gamePin, state: 'SCOREBOARD' });
          if (session) session = session.toObject();
        }

        if (!session) {
          return socket.emit('error', { message: 'Game session must be showing the scoreboard to advance' });
        }

        if (session.host.toString() !== socket.userId) {
          return socket.emit('error', { message: 'Only the host can advance the game' });
        }

        const quiz = await Quiz.findById(session.quiz);
        if (!quiz) return socket.emit('error', { message: 'Quiz not found' });
        activeQuizzes[gamePin] = quiz;

        const nextIndex = session.currentQuestionIndex + 1;

        if (nextIndex >= quiz.questions.length) {
          // No more questions - End the Game
          session.state = 'FINISHED';
          session.finishedAt = new Date();

          GameSession.findByIdAndUpdate(session._id, {
            state: 'FINISHED',
            finishedAt: session.finishedAt
          }).catch(err => console.error('DB Update error:', err));

          await delRoomCache(gamePin);
          delete activeQuizzes[gamePin];

          const finalLeaderboard = [...session.players].sort((a, b) => b.score - a.score);

          io.to(`room:${gamePin}`).emit('game_over', {
            leaderboard: finalLeaderboard.map((p, idx) => ({
              rank: idx + 1,
              nickname: p.nickname,
              avatar: p.avatar,
              score: p.score
            }))
          });
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

          await setRoomCache(gamePin, session);

          const nextQuestion = quiz.questions[nextIndex];

          io.to(`room:${gamePin}`).emit('question_start', {
            questionIndex: nextIndex,
            questionText: nextQuestion.question,
            options: nextQuestion.options,
            timeLimit: nextQuestion.timeLimit,
            totalQuestions: quiz.questions.length,
            backgroundMusic: session.backgroundMusic || 'off'
          });

          startCountdown(io, gamePin, nextQuestion.timeLimit);
        }
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // 3b. Host closes / aborts the room entirely (Host cancels lobby or clicks Close Room)
    socket.on('host_close_room', async ({ gamePin }: { gamePin: string }) => {
      try {
        const session = await GameSession.findOne({ gamePin });
        if (session) {
          session.state = 'FINISHED';
          session.finishedAt = new Date();
          await session.save();
        }

        // Delete cache
        await delRoomCache(gamePin);
        delete activeQuizzes[gamePin];

        // Notify all clients in the room that the room is closed
        io.to(`room:${gamePin}`).emit('room_closed', {
          message: 'The host has ended this game session.'
        });

        // Let all sockets leave the room
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

        // Delete active timer
        if (activeTimers[gamePin]) {
          clearTimeout(activeTimers[gamePin]);
          delete activeTimers[gamePin];
        }

        console.log(`Host aborted room:${gamePin}`);
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // --- PLAYER HANDLERS ---

    // 4. Player joins a lobby room
    socket.on('player_join_lobby', async ({ gamePin, nickname, avatar }: { gamePin: string; nickname: string; avatar: string }) => {
      try {
        if (!gamePin || !nickname || !avatar) {
          return socket.emit('error', { message: 'Pin, Nickname, and Avatar are required' });
        }

        // The read-check-modify-write below must be atomic per room: without the
        // lock, two players joining in the same instant could both read the same
        // pre-join state and each write their own version back, silently dropping
        // whichever player's update got overwritten (and letting the room exceed
        // its player cap, since both reads would see it as not-yet-full).
        const result = await withRoomLock(gamePin, async () => {
          let session = await getRoomCache(gamePin);
          if (!session) {
            const dbSession = await GameSession.findOne({ gamePin, state: 'LOBBY' });
            if (dbSession) {
              session = dbSession.toObject();
            }
          }

          if (!session || session.state !== 'LOBBY') {
            return { status: 'error' as const, message: 'Active game lobby not found. Check the Game Pin.' };
          }

          // Verify nickname is unique in this room
          const nameExists = session.players.some((p: any) => p.nickname.toLowerCase() === nickname.trim().toLowerCase());
          if (nameExists) {
            return { status: 'join_failed' as const, message: 'Nickname is already taken. Try another!' };
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

          // Update Cache
          await setRoomCache(gamePin, session);

          return { status: 'ok' as const, newPlayer, players: session.players };
        });

        if (result.status === 'error') {
          return socket.emit('error', { message: result.message });
        }
        if (result.status === 'join_failed') {
          return socket.emit('join_failed', { message: result.message });
        }

        const { newPlayer, players } = result;
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
          players: playersList
        });

        // Broadcast updated players list to room
        io.to(`room:${gamePin}`).emit('lobby_update', {
          players: playersList
        });
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // Host manually removes a player from the lobby — e.g. a duplicate/ghost
    // entry left behind by a flaky connection, or someone who's clearly gone.
    // Scoped to LOBBY only for now: mid-game removal would need to touch
    // scoring/leaderboard logic and isn't handled here.
    socket.on('host_remove_player', async ({ gamePin, nickname }: { gamePin: string; nickname: string }) => {
      try {
        const result = await withRoomLock(gamePin, async () => {
          let session = await getRoomCache(gamePin);
          if (!session) {
            const dbSession = await GameSession.findOne({ gamePin, state: 'LOBBY' });
            if (dbSession) session = dbSession.toObject();
          }

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

          await setRoomCache(gamePin, session);

          return { status: 'ok' as const, removedPlayer, players: session.players };
        });

        if (result.status === 'error') {
          return socket.emit('error', { message: result.message });
        }

        // Disconnect the removed player's own socket from the room and notify them
        const removedSocketId = result.removedPlayer.socketId;
        if (removedSocketId) {
          const removedSocket = io.sockets.sockets.get(removedSocketId);
          if (removedSocket) {
            removedSocket.emit('removed_from_game', { message: 'The host has removed you from this game session.' });
            removedSocket.leave(`room:${gamePin}`);
          }
        }

        // Broadcast updated player list to remaining room members
        io.to(`room:${gamePin}`).emit('lobby_update', {
          players: result.players.map((p: any) => ({ nickname: p.nickname, avatar: p.avatar }))
        });

        console.log(`Host removed player "${nickname}" from room:${gamePin}`);
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // Helper to construct snapshot of active game room state for rejoining clients
    const getRoomStateSnapshot = async (session: any) => {
      const quiz = await Quiz.findById(session.quiz);
      let activeQuestionData = null;
      let secondsRemaining = 0;

      if (session.state === 'QUESTION_ACTIVE' && quiz) {
        const currentQuestion = quiz.questions[session.currentQuestionIndex];
        const timePassedMs = new Date().getTime() - new Date(session.questionActiveSince).getTime();
        secondsRemaining = Math.max(0, currentQuestion.timeLimit - Math.floor(timePassedMs / 1000));
        activeQuestionData = {
          questionIndex: session.currentQuestionIndex,
          questionText: currentQuestion.question,
          options: currentQuestion.options,
          timeLimit: currentQuestion.timeLimit,
          totalQuestions: quiz.questions.length
        };
      }

      const currentLeaderboard = [...session.players].sort((a, b) => b.score - a.score);
      const mappedLeaderboard = currentLeaderboard.map((p: any, idx) => ({
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
        totalQuestions: quiz ? quiz.questions.length : 0,
        quizTitle: quiz ? quiz.title : '',
        lobbyMusic: session.lobbyMusic || 'off',
        players: session.players.map((p: any) => ({ nickname: p.nickname, avatar: p.avatar })),
        activeQuestion: activeQuestionData,
        leaderboard: mappedLeaderboard
      };
    };

    // 4b. Host re-joins after page refresh/reconnect
    socket.on('host_rejoin', async ({ gamePin }: { gamePin: string }) => {
      try {
        let session = await getRoomCache(gamePin);
        if (!session) {
          const dbSession = await GameSession.findOne({ gamePin });
          if (dbSession) session = dbSession.toObject();
        }

        if (!session) return;

        socket.join(`room:${gamePin}`);
        console.log(`Host re-joined room:${gamePin}`);

        const roomState = await getRoomStateSnapshot(session);
        socket.emit('rejoin_success', { roomState });
      } catch (e) {
        console.error('Host rejoin error:', e);
      }
    });

    // 4c. Player re-joins after page refresh/reconnect
    socket.on('player_rejoin', async ({ gamePin, nickname }: { gamePin: string; nickname: string }) => {
      try {
        let session = await getRoomCache(gamePin);
        if (!session) {
          const dbSession = await GameSession.findOne({ gamePin });
          if (dbSession) session = dbSession.toObject();
        }

        if (!session) return;

        const player = session.players.find((p: any) => p.nickname.toLowerCase() === nickname.toLowerCase().trim());
        if (player) {
          player.socketId = socket.id;
          
          GameSession.updateOne(
            { _id: session._id, 'players.nickname': player.nickname },
            { $set: { 'players.$.socketId': socket.id } }
          ).catch(err => console.error('DB Rejoin Update error:', err));

          await setRoomCache(gamePin, session);

          socket.join(`room:${gamePin}`);
          console.log(`Player ${nickname} re-joined room:${gamePin} with socket ${socket.id}`);

          const roomState = await getRoomStateSnapshot(session);
          socket.emit('rejoin_success', {
            roomState,
            player: {
              nickname: player.nickname,
              avatar: player.avatar
            }
          });

          io.to(`room:${gamePin}`).emit('lobby_update', {
            players: session.players.map((p: any) => ({
              nickname: p.nickname,
              avatar: p.avatar
            }))
          });
        }
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
          let session = await getRoomCache(gamePin);
          if (!session) {
            const dbSession = await GameSession.findOne({ gamePin, state: 'QUESTION_ACTIVE' });
            if (dbSession) session = dbSession.toObject();
          }

          if (!session || session.state !== 'QUESTION_ACTIVE') {
            return { status: 'error' as const, message: 'Game is not accepting answers right now' };
          }

          const player = session.players.find((p: any) => p.socketId === socket.id);
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
          if (!quiz) {
            quiz = await Quiz.findById(session.quiz);
            if (!quiz) return { status: 'error' as const, message: 'Quiz not found' };
            activeQuizzes[gamePin] = quiz;
          }

          const currentQuestion = quiz.questions[session.currentQuestionIndex];
          const isCorrect = (selectedAnswer === currentQuestion.correctOption);

          const timeTakenMs = new Date().getTime() - new Date(session.questionActiveSince).getTime();
          const timeLimitMs = currentQuestion.timeLimit * 1000;

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
            submittedAt: new Date()
          };

          player.answers.push(answerLog);
          player.score += scoreAwarded;

          GameSession.updateOne(
            { _id: session._id, 'players.socketId': socket.id },
            {
              $push: { 'players.$.answers': answerLog },
              $inc: { 'players.$.score': scoreAwarded }
            }
          ).catch(err => console.error('DB Update error:', err));

          await setRoomCache(gamePin, session);

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
        socket.emit('error', { message: err.message });
      }
    });

    // 6. Handle client disconnect (Survives refreshes - player is not auto-evicted)
    socket.on('disconnect', async () => {
      console.log('Client socket disconnected:', socket.id);
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

const endQuestion = async (io: Server, gamePin: string) => {
  delete activeTimers[gamePin];

  try {
    // Wrapped in the same per-room lock as player_submit_answer so a
    // timer expiring at the exact instant the last player answers (both
    // paths call endQuestion) can't run concurrently and double-broadcast.
    // The QUESTION_ACTIVE guard below makes a second, queued-up call a safe
    // no-op once the first call has already transitioned the room's state.
    await withRoomLock(gamePin, async () => {
      let session = await getRoomCache(gamePin);
      if (!session) {
        session = await GameSession.findOne({ gamePin, state: 'QUESTION_ACTIVE' });
        if (session) session = session.toObject();
      }

      if (!session || session.state !== 'QUESTION_ACTIVE') return;

      let quiz = activeQuizzes[gamePin];
      if (!quiz) {
        quiz = await Quiz.findById(session.quiz);
        if (!quiz) return;
        activeQuizzes[gamePin] = quiz;
      }

      const currentQuestion = quiz.questions[session.currentQuestionIndex];
      const isLastQuestion = (session.currentQuestionIndex + 1 >= quiz.questions.length);

      if (isLastQuestion) {
        session.state = 'FINISHED';
        session.finishedAt = new Date();

        GameSession.findByIdAndUpdate(session._id, {
          state: 'FINISHED',
          finishedAt: session.finishedAt
        }).catch(err => console.error('DB Update error:', err));

        await delRoomCache(gamePin);
        delete activeQuizzes[gamePin];

        const finalLeaderboard = [...session.players].sort((a, b) => b.score - a.score);

        io.to(`room:${gamePin}`).emit('game_over', {
          leaderboard: finalLeaderboard.map((p, idx) => ({
            rank: idx + 1,
            nickname: p.nickname,
            avatar: p.avatar,
            score: p.score
          }))
        });
      } else {
        session.state = 'SCOREBOARD';

        // Update DB in background
        GameSession.findByIdAndUpdate(session._id, { state: 'SCOREBOARD' }).catch(err => console.error('DB Update error:', err));

        // Update cache
        await setRoomCache(gamePin, session);

        const currentLeaderboard = [...session.players].sort((a, b) => b.score - a.score);

        io.to(`room:${gamePin}`).emit('question_ended', {
          correctOption: currentQuestion.correctOption,
          leaderboard: currentLeaderboard.map((p: any, idx) => ({
            rank: idx + 1,
            nickname: p.nickname,
            avatar: p.avatar,
            score: p.score,
            isCorrect: p.answers.find((ans: any) => ans.questionIndex === session.currentQuestionIndex)?.isCorrect || false
          }))
        });
      }
    });
  } catch (err) {
    console.error('Error ending question:', err);
  }
};
