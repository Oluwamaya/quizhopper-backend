import { Router } from 'express';
import {
  createQuiz,
  editQuiz,
  deleteQuiz,
  getUserLibrary,
  getMarketplaceQuizzes,
  getQuizById,
  generateQuizWithAI
} from '../controllers/quizController';
import { protect } from '../middlewares/authMiddleware';
import { aiGenerationLimiter } from '../middlewares/rateLimiters';

const router = Router();

// Retrieve all quizzes in user's library (Defaults + Created + Purchased)
router.get('/library', protect, getUserLibrary);

const MARKETPLACE_ENABLED = false;

// Retrieve all quizzes listed on the marketplace
router.get('/marketplace', protect, (req, res, next) => {
  if (!MARKETPLACE_ENABLED) {
    return res.status(404).json({ success: false, message: 'Quiz Marketplace is currently unavailable' });
  }
  next();
}, getMarketplaceQuizzes);

// Generate a set of quiz questions with AI (coins charged, nothing saved
// until the user reviews and submits via the normal create endpoint)
router.post('/generate-ai', protect, aiGenerationLimiter, generateQuizWithAI);

// Create a new quiz
router.post('/', protect, createQuiz);

// Retrieve specific quiz details by ID
router.get('/:id', protect, getQuizById);

// Update/Edit an existing quiz
router.put('/:id', protect, editQuiz);

// Delete an existing quiz
router.delete('/:id', protect, deleteQuiz);

export default router;
