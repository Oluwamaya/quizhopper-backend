import { Response } from 'express';
import { Quiz } from '../models/Quiz';
import { QuizPurchase } from '../models/QuizPurchase';
import { AuthRequest } from '../middlewares/authMiddleware';

// Create a custom quiz
export const createQuiz = async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, questions, price, isPublishedToMarketplace } = req.body;
    
    if (!title || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, message: 'Title and at least one question are required' });
    }

    // Validate correctOption structure
    for (const q of questions) {
      if (!q.question || !q.options || !Array.isArray(q.options) || q.options.length < 2) {
        return res.status(400).json({ success: false, message: 'Each question must have text and at least 2 options' });
      }
      if (!q.correctOption || !q.options.includes(q.correctOption)) {
        return res.status(400).json({ success: false, message: `The correct option "${q.correctOption}" must be one of the choices` });
      }
    }

    const quiz = await Quiz.create({
      title,
      description,
      creator: req.userId,
      questions,
      price: price || 0,
      isPublishedToMarketplace: !!isPublishedToMarketplace,
      isDefault: false
    });

    return res.status(201).json({ success: true, quiz });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Edit a custom quiz
export const editQuiz = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, questions, price, isPublishedToMarketplace } = req.body;
    const userId = req.userId;

    const quiz = await Quiz.findById(id);
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }

    // Guard: Only creator can edit
    if (quiz.creator?.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access Denied: You are not the creator of this quiz' });
    }

    // If quiz is default, block editing
    if (quiz.isDefault) {
      return res.status(400).json({ success: false, message: 'Cannot edit system default quizzes' });
    }

    // Apply updates
    if (title !== undefined) quiz.title = title;
    if (description !== undefined) quiz.description = description;
    if (price !== undefined) quiz.price = price;
    if (isPublishedToMarketplace !== undefined) quiz.isPublishedToMarketplace = !!isPublishedToMarketplace;
    
    if (questions !== undefined) {
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one question is required' });
      }
      for (const q of questions) {
        if (!q.question || !q.options || !Array.isArray(q.options) || q.options.length < 2) {
          return res.status(400).json({ success: false, message: 'Each question must have text and at least 2 options' });
        }
        if (!q.correctOption || !q.options.includes(q.correctOption)) {
          return res.status(400).json({ success: false, message: `The correct option "${q.correctOption}" must be one of the choices` });
        }
      }
      quiz.questions = questions;
    }

    await quiz.save();
    return res.status(200).json({ success: true, message: 'Quiz updated successfully', quiz });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete a custom quiz
export const deleteQuiz = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const quiz = await Quiz.findById(id);
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }

    // Guard: Only creator can delete
    if (quiz.creator?.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access Denied: You are not the creator of this quiz' });
    }

    // Guard: System default quizzes cannot be deleted
    if (quiz.isDefault) {
      return res.status(400).json({ success: false, message: 'Cannot delete system default quizzes' });
    }

    // Guard: Check if the quiz has already been purchased by other users
    const hasBeenPurchased = await QuizPurchase.exists({ quiz: id });
    if (hasBeenPurchased) {
      return res.status(400).json({ 
        success: false, 
        message: 'This quiz has been purchased by other users and cannot be deleted. You can only edit it to correct questions or add new ones.' 
      });
    }

    await Quiz.findByIdAndDelete(id);
    return res.status(200).json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Get all quizzes available to the current user (Own creations + Purchased + Defaults)
export const getUserLibrary = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;

    const myCreatedQuizzes = await Quiz.find({ creator: userId });
    const defaultQuizzes = await Quiz.find({ isDefault: true });

    const purchases = await QuizPurchase.find({ buyer: userId }).populate('quiz');
    const purchasedQuizzes = purchases.map((p: any) => p.quiz).filter((q) => q !== null);

    const library = [...myCreatedQuizzes, ...defaultQuizzes, ...purchasedQuizzes];
    
    // De-duplicate by ID
    const uniqueLibrary = Array.from(new Map(library.map(q => [q._id.toString(), q])).values());

    return res.status(200).json({ success: true, count: uniqueLibrary.length, library: uniqueLibrary });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Get marketplace listings (published, not created by the requester, and not already purchased by them)
export const getMarketplaceQuizzes = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;

    const marketplace = await Quiz.find({
      isPublishedToMarketplace: true,
      creator: { $ne: userId }
    }).populate('creator', 'displayName');

    const purchased = await QuizPurchase.find({ buyer: userId });
    const purchasedIds = new Set(purchased.map(p => p.quiz.toString()));

    const availableMarketplace = marketplace.filter(quiz => !purchasedIds.has(quiz._id.toString()));

    return res.status(200).json({ success: true, count: availableMarketplace.length, quizzes: availableMarketplace });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Get single quiz by ID
export const getQuizById = async (req: AuthRequest, res: Response) => {
  try {
    const quiz = await Quiz.findById(req.params.id).populate('creator', 'displayName');
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }
    return res.status(200).json({ success: true, quiz });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
