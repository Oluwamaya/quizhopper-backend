import { Router } from 'express';
import { 
  createQuiz, 
  editQuiz,
  deleteQuiz,
  getUserLibrary, 
  getMarketplaceQuizzes, 
  getQuizById 
} from '../controllers/quizController';
import { protect } from '../middlewares/authMiddleware';

const router = Router();

// Retrieve all quizzes in user's library (Defaults + Created + Purchased)
router.get('/library', protect, getUserLibrary);

// Retrieve all quizzes listed on the marketplace
router.get('/marketplace', protect, getMarketplaceQuizzes);

// Create a new quiz
router.post('/', protect, createQuiz);

// Retrieve specific quiz details by ID
router.get('/:id', protect, getQuizById);

// Update/Edit an existing quiz
router.put('/:id', protect, editQuiz);

// Delete an existing quiz
router.delete('/:id', protect, deleteQuiz);

export default router;
