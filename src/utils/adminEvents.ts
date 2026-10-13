import { Server } from 'socket.io';

// Pushes a live transaction event to connected admin sockets (joined via
// the same 'support_admins' room used for live ticket notifications — one
// registration on the client covers both). `io` is optional/nullable since
// callers resolve it differently depending on context (Express req.app vs.
// a socket handler's own io instance already in scope), and some very early
// app-boot paths may not have it wired yet. Fire-and-forget: callers don't
// await this, it's a non-blocking side effect of an already-completed write.
export const emitAdminTransaction = async (io: Server | undefined | null, transaction: any) => {
  if (!io) return;
  try {
    // Populate here (once, centrally) rather than at every call site, so the
    // admin panel's live feed always has displayName/email to show without
    // each caller needing to remember to populate before emitting.
    if (typeof transaction.populate === 'function') {
      await transaction.populate('user', 'displayName email');
    }
  } catch (err) {
    console.error('emitAdminTransaction: failed to populate user, emitting unpopulated', err);
  }
  io.to('support_admins').emit('admin_new_transaction', transaction);
};

// Pushes a live wallet update to every connection this user currently has
// open (their own private `user:${userId}` room, joined on every
// authenticated socket connection — see gameSocket.ts). This is the only
// way to reach a client for updates that don't originate from that client's
// own HTTP request — a Paystack webhook crediting a deposit, or an admin
// adjusting someone's balance from the admin panel — and is used alongside
// (not instead of) the direct response-based updates already in place for
// requests the user's own client initiated.
export const emitWalletUpdate = (
  io: Server | undefined | null,
  userId: string | undefined | null,
  wallet: { coins?: number; balance?: number }
) => {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit('wallet_updated', wallet);
};
