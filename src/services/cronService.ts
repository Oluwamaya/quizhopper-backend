import { Server } from 'socket.io';
import { GameSession } from '../models/GameSession';
import { delRoomCache } from './redisService';
import { clearRoomMemory, forceCloseActiveRoom } from '../sockets/gameSocket';
import { cancelAndRefundJackpotRoom } from './jackpotService';

// Jackpot lobbies that sit unstarted for 60 minutes are auto-cancelled and
// every paid player's entry coins are refunded automatically.
const JACKPOT_LOBBY_TIMEOUT_MINUTES = 60;

export const startSessionCleanupCron = (io: Server) => {
  console.log('[Cron] Session cleanup scheduler initialized. Scanning every 5 minutes.');

  // Run cleanup routine every 5 minutes (300,000 milliseconds)
  setInterval(async () => {
    try {
      const now = new Date();
      
      // Find all sessions that are not marked as finished or cancelled
      const activeSessions = await GameSession.find({ state: { $nin: ['FINISHED', 'CANCELLED'] } });

      for (const session of activeSessions) {
        const ageMs = now.getTime() - session.createdAt.getTime();
        const ageMinutes = ageMs / (1000 * 60);

        // Jackpot rooms: auto-cancel & refund all paid players if never started
        // within 60 minutes, or if abandoned mid-game for over 2 hours.
        if (session.isJackpot) {
          let jackpotReason = '';
          if (session.state === 'LOBBY' && ageMinutes >= JACKPOT_LOBBY_TIMEOUT_MINUTES) {
            jackpotReason = `Jackpot room did not start within ${JACKPOT_LOBBY_TIMEOUT_MINUTES} minutes`;
          } else if (session.state !== 'LOBBY' && ageMinutes >= 120) {
            jackpotReason = 'Active Jackpot room remained open for over 2 hours without finishing';
          }

          if (jackpotReason) {
            const refundResult = await cancelAndRefundJackpotRoom(
              io,
              { sessionId: String(session._id) },
              jackpotReason
            );
            await forceCloseActiveRoom(
              io,
              session.gamePin,
              'This Jackpot Room did not complete and was automatically cancelled. Any entry coins have been refunded to your wallet.'
            );
            console.log(
              `[Cron] Auto-cancelled Jackpot room:${session.gamePin} (${jackpotReason}). Refunded ${refundResult.totalCoinsRefunded} coins across ${refundResult.refundedCount} player(s).`
            );
          }
          continue;
        }

        let shouldClose = false;
        let reason = '';

        // Case 1: Lobby created but empty for over 30 minutes
        if (session.state === 'LOBBY' && session.players.length === 0 && ageMinutes >= 30) {
          shouldClose = true;
          reason = 'Lobby remained empty for over 30 minutes';
        }
        
        // Case 2: Abandoned live room open for over 2 hours (host forgot to end it)
        if (session.state !== 'LOBBY' && ageMinutes >= 120) {
          shouldClose = true;
          reason = 'Active match remained open for over 2 hours';
        }

        if (shouldClose) {
          session.state = 'FINISHED';
          session.finishedAt = now;
          await session.save();

          // Delete from Redis cache and this process's in-memory room caches —
          // without this, every abandoned lobby/match the cron force-closes
          // would leave its quiz + session data sitting in memory forever.
          await delRoomCache(session.gamePin);
          clearRoomMemory(session.gamePin);

          // Evict all sockets in that room
          io.to(`room:${session.gamePin}`).emit('room_closed', {
            message: 'This session has been closed due to inactivity.'
          });

          // Force clients to leave the channel room
          const roomName = `room:${session.gamePin}`;
          const activeSockets = io.sockets.adapter.rooms.get(roomName);
          if (activeSockets) {
            for (const socketId of activeSockets) {
              const clientSocket = io.sockets.sockets.get(socketId);
              if (clientSocket) {
                clientSocket.leave(roomName);
              }
            }
          }

          console.log(`[Cron] Automatically closed inactive session room:${session.gamePin}. Reason: ${reason}`);
        }
      }
    } catch (err) {
      console.error('[Cron] Error running session cleanup:', err);
    }
  }, 300000); // 5 minutes
};
