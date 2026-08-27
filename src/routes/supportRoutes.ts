import { Router, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { SupportTicket } from '../models/SupportTicket';
import { protect, AuthRequest } from '../middlewares/authMiddleware';
import { adminProtect } from '../middlewares/adminMiddleware';
import { uploadLimiter } from '../middlewares/rateLimiters';
import { isStorageConfigured, uploadToStorage } from '../services/storageService';

const router = Router();

const GUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;
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

// 1. Get or Create active ticket for guest session
router.get('/ticket/:guestId', async (req: AuthRequest, res: Response) => {
  const { guestId } = req.params;

  if (!GUEST_ID_PATTERN.test(guestId)) {
    return res.status(400).json({ success: false, message: 'Invalid guest session identifier' });
  }

  const rawDisplayName = typeof req.query.displayName === 'string' ? req.query.displayName : '';
  const displayName = (rawDisplayName.trim() || `Guest_${guestId.slice(0, 5)}`).slice(0, 40);

  try {
    let ticket = await SupportTicket.findOne({ guestId });
    if (!ticket) {
      ticket = await SupportTicket.create({
        guestId,
        displayName,
        messages: [{
          sender: 'agent',
          text: `Hello ${displayName}! Welcome to Mayacode Technologies live support. Please type your complaint or upload your payment screenshots below.`,
          createdAt: new Date()
        }],
        status: 'open'
      });
    }
    return res.status(200).json({ success: true, ticket });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Admin-only: Fetch all active support tickets
router.get('/tickets', protect, adminProtect, async (req: AuthRequest, res: Response) => {
  try {
    const tickets = await SupportTicket.find().sort({ updatedAt: -1 });
    return res.status(200).json({ success: true, tickets });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
