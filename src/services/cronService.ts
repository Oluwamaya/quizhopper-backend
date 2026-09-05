import { Server } from 'socket.io';
import { GameSession } from '../models/GameSession';
import { delRoomCache } from './redisService';
import { clearRoomMemory } from '../sockets/gameSocket';

export const startSessionCleanupCron = (io: Server) => {
  console.log('[Cron] Session cleanup scheduler initialized. Scanning every 5 minutes.');

  // Run cleanup routine every 5 minutes (300,000 milliseconds)
  setInterval(async () => {
    try {
      const now = new Date();
      
      // Find all sessions that are not marked as finished
      const activeSessions = await GameSession.find({ state: { $ne: 'FINISHED' } });

      for (const session of activeSessions) {
        let shouldClose = false;
        let reason = '';

        const ageMs = now.getTime() - session.createdAt.getTime();
        const ageMinutes = ageMs / (1000 * 60);

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
