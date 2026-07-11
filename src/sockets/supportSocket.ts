import { Server, Socket } from 'socket.io';
import { SupportTicket } from '../models/SupportTicket';

export const setupSupportSockets = (io: Server) => {
  io.on('connection', (socket: Socket) => {
    // 1. Client/User joins their support room
    socket.on('support_join', ({ guestId }: { guestId: string }) => {
      socket.join(`support:${guestId}`);
    });

    // 2. Admin registers to receive all live support ticket update events
    socket.on('support_admin_register', () => {
      socket.join('support_admins');
    });

    // 3. User sends a complaint or payment issue
    socket.on('support_user_message', async ({ guestId, text, attachmentUrl }: { guestId: string; text: string; attachmentUrl?: string }) => {
      try {
        let ticket = await SupportTicket.findOne({ guestId });
        if (!ticket) return;

        ticket.messages.push({
          sender: 'user',
          text,
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
          lastMessage: text || 'Uploaded attachment',
          updatedAt: ticket.updatedAt
        });
      } catch (err: any) {
        console.error('Support user message socket error:', err);
      }
    });

    // 4. Admin replies to ticket
    socket.on('support_admin_message', async ({ guestId, text, attachmentUrl }: { guestId: string; text: string; attachmentUrl?: string }) => {
      try {
        let ticket = await SupportTicket.findOne({ guestId });
        if (!ticket) return;

        ticket.messages.push({
          sender: 'admin',
          text,
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
          lastMessage: text || 'Uploaded attachment',
          updatedAt: ticket.updatedAt
        });
      } catch (err: any) {
        console.error('Support admin message socket error:', err);
      }
    });
  });
};
