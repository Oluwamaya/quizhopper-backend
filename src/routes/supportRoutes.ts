import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { SupportTicket } from '../models/SupportTicket';
import { protect, AuthRequest } from '../middlewares/authMiddleware';
import { adminProtect } from '../middlewares/adminMiddleware';

const router = Router();

// 1. Get or Create active ticket for guest session
router.get('/ticket/:guestId', async (req: AuthRequest, res: Response) => {
  const { guestId } = req.params;
  const displayName = (req.query.displayName as string) || `Guest_${guestId.slice(0, 5)}`;
  
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

// 2. Upload file via base64 encoding (reusing public uploads layout)
router.post('/upload', async (req: AuthRequest, res: Response) => {
  const { fileName, fileData } = req.body;
  if (!fileName || !fileData) {
    return res.status(400).json({ success: false, message: 'Missing file metadata or content payload' });
  }

  try {
    const matches = fileData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let base64Buffer: Buffer;
    
    if (matches && matches.length === 3) {
      base64Buffer = Buffer.from(matches[2], 'base64');
    } else {
      base64Buffer = Buffer.from(fileData, 'base64');
    }

    const uploadDir = path.join(__dirname, '../../public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const sanitizedName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
    const destinationPath = path.join(uploadDir, sanitizedName);
    
    fs.writeFileSync(destinationPath, base64Buffer);

    return res.status(200).json({ 
      success: true, 
      url: `/uploads/${sanitizedName}`,
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
