import { Router, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { SupportTicket } from '../models/SupportTicket';
import { User } from '../models/User';
import { protect, optionalAuth, AuthRequest } from '../middlewares/authMiddleware';
import { adminProtect } from '../middlewares/adminMiddleware';
import { uploadLimiter } from '../middlewares/rateLimiters';
import { isStorageConfigured, uploadToStorage } from '../services/storageService';
import { sendServerError } from '../middlewares/errorHandler';

const router = Router();

const GUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
};
const ALLOWED_MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));

// 1. Get or create the active ticket for this visitor. Identity resolution:
//  - Logged-in visitor (valid JWT, checked via optionalAuth): the ticket is
//    always keyed by their account (`user_<userId>`), ignoring whatever
//    guestId the client sent — so the same account resumes the same
//    conversation from any browser/device, not just the one that happens to
//    still have the right localStorage value.
//  - Anonymous visitor: keyed by the client-generated guestId as before, but
//    now requires an email on file (passed once via ?email=, compulsory —
//    see the support widget's email gate) before a ticket can be created, so
//    there's a durable contact even if that browser's local identity is lost.
router.get('/ticket/:guestId', optionalAuth, async (req: AuthRequest, res: Response) => {
  const rawDisplayName = typeof req.query.displayName === 'string' ? req.query.displayName : '';
  const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';

  let effectiveGuestId: string;
  let accountDisplayName: string | undefined;
  let accountEmail: string | undefined;

  if (req.userId) {
    effectiveGuestId = `user_${req.userId}`;
    const user = await User.findById(req.userId).select('displayName email');
    if (user) {
      accountDisplayName = user.displayName;
      accountEmail = user.email;
    }
  } else {
    effectiveGuestId = req.params.guestId;
    if (!GUEST_ID_PATTERN.test(effectiveGuestId)) {
      return res.status(400).json({ success: false, message: 'Invalid guest session identifier' });
    }
    if (!rawEmail || !EMAIL_PATTERN.test(rawEmail)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required to start a support chat' });
    }
  }

  const displayName = (accountDisplayName || rawDisplayName.trim() || `Guest_${effectiveGuestId.slice(0, 5)}`).slice(0, 40);

  try {
    let ticket = await SupportTicket.findOne({ guestId: effectiveGuestId });
    if (!ticket) {
      ticket = await SupportTicket.create({
        guestId: effectiveGuestId,
        userId: req.userId || undefined,
        displayName,
        email: accountEmail || rawEmail || undefined,
        messages: [{
          sender: 'admin',
          text: `Hello ${displayName}! Welcome to Mayacode Technologies live support. Please type your complaint or upload your payment screenshots below.`,
          createdAt: new Date()
        }],
        status: 'open'
      });
    } else if (!ticket.email && (accountEmail || rawEmail)) {
      // Backfill email on a ticket created before this field existed.
      ticket.email = accountEmail || rawEmail;
      await ticket.save();
    }
    return res.status(200).json({ success: true, ticket });
  } catch (err: any) {
    return sendServerError(res, err, 'GET /support/ticket/:guestId');
  }
});

// 2. Upload file via base64 encoding, stored in Cloudinary (not local disk —
// Render's filesystem is ephemeral and wipes on every restart).
// Intentionally reachable by anonymous guests (the live support widget has
// no login requirement), but rate-limited and capped/allow-listed to stop
// storage-abuse DoS and arbitrary file-type uploads.
router.post('/upload', uploadLimiter, async (req: AuthRequest, res: Response) => {
  if (!isStorageConfigured()) {
    return res.status(503).json({ success: false, message: 'File uploads are not configured. Please contact support.' });
  }

  const { fileName, fileData } = req.body;
  if (!fileName || !fileData || typeof fileName !== 'string' || typeof fileData !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing file metadata or content payload' });
  }

  if (fileName.length > 200) {
    return res.status(400).json({ success: false, message: 'File name is too long' });
  }

  const extension = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return res.status(400).json({ success: false, message: 'Unsupported file type. Allowed: images and PDF.' });
  }

  try {
    const matches = fileData.match(/^data:([A-Za-z0-9-+\/]+);base64,(.+)$/);
    let base64Payload: string;
    let mimeType: string | undefined;

    if (matches && matches.length === 3) {
      mimeType = matches[1];
      base64Payload = matches[2];
    } else {
      base64Payload = fileData;
    }

    if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ success: false, message: 'Unsupported file type. Allowed: images and PDF.' });
    }

    if (!/^[A-Za-z0-9+/]+=*$/.test(base64Payload)) {
      return res.status(400).json({ success: false, message: 'Invalid file content encoding' });
    }

    const base64Buffer = Buffer.from(base64Payload, 'base64');

    if (base64Buffer.length === 0) {
      return res.status(400).json({ success: false, message: 'File content is empty' });
    }

    if (base64Buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ success: false, message: 'File exceeds the 5MB upload limit' });
    }

    const contentType = (mimeType && ALLOWED_MIME_TYPES.has(mimeType) ? mimeType : MIME_BY_EXTENSION[extension]);
    const baseName = `${Date.now()}_${crypto.randomUUID()}`;
    const sanitizedName = `${baseName}${extension}`;

    // Images go through Cloudinary's `image` pipeline, which appends its
    // own detected format to the delivery URL regardless of what's in the
    // public_id, so the extension is omitted there. PDFs use `raw` (stored
    // as-is, no conversion) — for `raw`, Cloudinary does NOT auto-append an
    // extension, so the public_id needs one for the delivered file to
    // actually carry .pdf.
    const isPdf = extension === '.pdf';
    const publicId = isPdf ? `support-uploads/${sanitizedName}` : `support-uploads/${baseName}`;

    const url = await uploadToStorage(publicId, base64Buffer, contentType, isPdf ? 'raw' : 'image');

    return res.status(200).json({
      success: true,
      url,
      fileName: sanitizedName
    });
  } catch (err: any) {
    return sendServerError(res, err, 'POST /support/upload');
  }
});

// 3. Admin-only: Fetch support tickets, paginated and sorted unread-first
// (then most recently active). Each ticket's `messages` is projected down
// to just the last entry — the list view only ever shows a snippet, and
// with dozens of long-running conversations the full thread history would
// make this payload unnecessarily heavy. The full thread is fetched
// separately via GET /ticket/:guestId when an admin opens one.
router.get('/tickets', protect, adminProtect, async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const statusParam = req.query.status;
    const filter = (statusParam === 'open' || statusParam === 'closed') ? { status: statusParam } : {};

    const [tickets, totalCount, unreadCount] = await Promise.all([
      SupportTicket.find(filter, {
        guestId: 1,
        displayName: 1,
        email: 1,
        status: 1,
        adminUnread: 1,
        updatedAt: 1,
        messages: { $slice: -1 }
      })
        .sort({ adminUnread: -1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SupportTicket.countDocuments(filter),
      // Always the true open+unread count, independent of the status filter
      // above — the sidebar badge should reflect what needs attention
      // regardless of which view the admin currently has selected.
      SupportTicket.countDocuments({ status: 'open', adminUnread: true })
    ]);

    return res.status(200).json({
      success: true,
      tickets,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      unreadCount
    });
  } catch (err: any) {
    return sendServerError(res, err, 'GET /support/tickets');
  }
});

// 4. Admin-only: Close support ticket case
router.post('/ticket/:guestId/close', protect, adminProtect, async (req: AuthRequest, res: Response) => {
  const { guestId } = req.params;
  try {
    const ticket = await SupportTicket.findOneAndUpdate(
      { guestId },
      { status: 'closed' },
      { new: true }
    );
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    return res.status(200).json({ success: true, ticket });
  } catch (err: any) {
    return sendServerError(res, err, 'POST /support/ticket/:guestId/close');
  }
});

// 5. Admin-only: Delete a single ticket permanently. Only resolved/closed
// tickets may be deleted — an open ticket may still need a reply, and
// deleting it would silently drop an unresolved complaint.
router.delete('/ticket/:guestId', protect, adminProtect, async (req: AuthRequest, res: Response) => {
  const { guestId } = req.params;
  if (!GUEST_ID_PATTERN.test(guestId)) {
    return res.status(400).json({ success: false, message: 'Invalid guest session identifier' });
  }
  try {
    const ticket = await SupportTicket.findOne({ guestId });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    if (ticket.status !== 'closed') {
      return res.status(400).json({ success: false, message: 'Only resolved tickets can be deleted — close this ticket first' });
    }
    await ticket.deleteOne();
    const io = req.app.get('socketio');
    if (io) io.to('support_admins').emit('support_ticket_deleted', { guestId });
    return res.status(200).json({ success: true });
  } catch (err: any) {
    return sendServerError(res, err, 'DELETE /support/ticket/:guestId');
  }
});

// 6. Admin-only: Bulk-delete tickets (the list's "select + delete" action).
// Only resolved/closed tickets are deleted — any open ones in the submitted
// list are silently skipped rather than rejecting the whole batch, since the
// client already excludes open tickets from selection; this is the
// server-side backstop against a direct API call bypassing that.
router.post('/tickets/bulk-delete', protect, adminProtect, async (req: AuthRequest, res: Response) => {
  const { guestIds } = req.body;
  if (!Array.isArray(guestIds) || guestIds.length === 0 || guestIds.length > 200) {
    return res.status(400).json({ success: false, message: 'guestIds must be a non-empty array of up to 200 ids' });
  }
  if (!guestIds.every((id: unknown) => typeof id === 'string' && GUEST_ID_PATTERN.test(id))) {
    return res.status(400).json({ success: false, message: 'Invalid guest session identifier in list' });
  }
  try {
    const closedTickets = await SupportTicket.find({ guestId: { $in: guestIds }, status: 'closed' }, { guestId: 1 });
    const deletableIds = closedTickets.map(t => t.guestId);
    if (deletableIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Only resolved tickets can be deleted — none of the selected tickets are resolved' });
    }

    const result = await SupportTicket.deleteMany({ guestId: { $in: deletableIds } });
    const io = req.app.get('socketio');
    if (io) io.to('support_admins').emit('support_tickets_deleted', { guestIds: deletableIds });
    return res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      skippedCount: guestIds.length - deletableIds.length
    });
  } catch (err: any) {
    return sendServerError(res, err, 'POST /support/tickets/bulk-delete');
  }
});

export default router;
