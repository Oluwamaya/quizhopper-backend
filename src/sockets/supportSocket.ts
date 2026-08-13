import { Server, Socket } from 'socket.io';
import { SupportTicket } from '../models/SupportTicket';
import { User } from '../models/User';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

const GUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;
const MAX_MESSAGE_LENGTH = 2000;

// Both connecting widgets and the admin dashboard share this Socket.IO
// server instance; the JWT-decoding io.use() middleware registered in
// gameSocket.ts already runs for every connection here too, so
// socket.userId is populated for logged-in users by the time 'connection'
// fires.
const isRequestingSocketAnAdmin = async (socket: AuthenticatedSocket): Promise<boolean> => {
  if (!socket.userId) return false;
  const user = await User.findById(socket.userId);
  return !!user?.isAdmin;
};

export const setupSupportSockets = (io: Server) => {
  io.on('connection', (socket: AuthenticatedSocket) => {
    // 1. Client/User joins their support room
    socket.on('support_join', ({ guestId }: { guestId: string }) => {
      if (typeof guestId !== 'string' || !GUEST_ID_PATTERN.test(guestId)) return;
      socket.join(`support:${guestId}`);
    });

    // 2. Admin registers to receive all live support ticket update events.
    // Must be a verified admin account — this room streams every guest's
    // complaint text and attachment URLs.
    socket.on('support_admin_register', async () => {
      try {
        if (!(await isRequestingSocketAnAdmin(socket))) {
          return socket.emit('error', { message: 'Access denied: admin privileges required' });
        }
        socket.join('support_admins');
      } catch (err) {
        console.error('Support admin register error:', err);
      }
    });

    // 3. User sends a complaint or payment issue
    socket.on('support_user_message', async ({ guestId, text, attachmentUrl }: { guestId: string; text: string; attachmentUrl?: string }) => {
      try {
        if (typeof guestId !== 'string' || !GUEST_ID_PATTERN.test(guestId)) return;
        if (text !== undefined && typeof text !== 'string') return;
        if (attachmentUrl !== undefined && typeof attachmentUrl !== 'string') return;
        if (!text && !attachmentUrl) return;

        const trimmedText = (text || '').slice(0, MAX_MESSAGE_LENGTH);

        let ticket = await SupportTicket.findOne({ guestId });
        if (!ticket) return;

        ticket.messages.push({
          sender: 'user',
          text: trimmedText,
          attachmentUrl,
          createdAt: new Date()
        });
        ticket.status = 'open'; // Re-open ticket if it was closed
        await ticket.save();

        // Broadcast new message to support room (user + responding admin)
        io.to(`support:${guestId}`).emit('support_message', {
          guestId,
          message: ticket.messages[ticket.messages.length - 1]
        });

        // Notify all admins on the dashboard
        io.to('support_admins').emit('support_ticket_updated', {
          guestId,
          displayName: ticket.displayName,
          status: ticket.status,
          lastMessage: trimmedText || 'Uploaded attachment',
          updatedAt: ticket.updatedAt
        });
      } catch (err: any) {
        console.error('Support user message socket error:', err);
      }
    });

    // 4. Admin replies to ticket — verified admin only, otherwise anyone
    // connected could impersonate support staff in any guest's ticket.
    socket.on('support_admin_message', async ({ guestId, text, attachmentUrl }: { guestId: string; text: string; attachmentUrl?: string }) => {
      try {
        if (!(await isRequestingSocketAnAdmin(socket))) {
          return socket.emit('error', { message: 'Access denied: admin privileges required' });
        }
        if (typeof guestId !== 'string' || !GUEST_ID_PATTERN.test(guestId)) return;
        if (text !== undefined && typeof text !== 'string') return;
        if (attachmentUrl !== undefined && typeof attachmentUrl !== 'string') return;
        if (!text && !attachmentUrl) return;

        const trimmedText = (text || '').slice(0, MAX_MESSAGE_LENGTH);

        let ticket = await SupportTicket.findOne({ guestId });
        if (!ticket) return;

        ticket.messages.push({
          sender: 'admin',
          text: trimmedText,
          attachmentUrl,
          createdAt: new Date()
        });
        await ticket.save();

        // Broadcast to support room
        io.to(`support:${guestId}`).emit('support_message', {
          guestId,
          message: ticket.messages[ticket.messages.length - 1]
        });

        // Notify admin panel
        io.to('support_admins').emit('support_ticket_updated', {
          guestId,
          displayName: ticket.displayName,
          status: ticket.status,
          lastMessage: trimmedText || 'Uploaded attachment',
          updatedAt: ticket.updatedAt
        });
      } catch (err: any) {
        console.error('Support admin message socket error:', err);
      }
    });
  });
};
