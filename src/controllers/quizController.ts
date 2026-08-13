import { Response } from 'express';
import { Quiz } from '../models/Quiz';
import { QuizPurchase } from '../models/QuizPurchase';
import { User } from '../models/User';
import { AuthRequest } from '../middlewares/authMiddleware';

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_QUESTIONS = 100;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTIONS_PER_QUESTION = 8;
const MAX_OPTION_TEXT_LENGTH = 200;

// Shared structural + size validation for quiz question payloads, used by
// both create and edit so free-text fields can't be used to bloat storage
// or (if ever rendered unescaped on the frontend) carry oversized payloads.
const validateQuestions = (questions: any): string | null => {
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'At least one question is required';
  }
  if (questions.length > MAX_QUESTIONS) {
    return `A quiz cannot have more than ${MAX_QUESTIONS} questions`;
  }
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question.trim() || q.question.length > MAX_QUESTION_TEXT_LENGTH) {
      return `Each question must have text under ${MAX_QUESTION_TEXT_LENGTH} characters`;
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > MAX_OPTIONS_PER_QUESTION) {
      return `Each question must have between 2 and ${MAX_OPTIONS_PER_QUESTION} options`;
    }
    if (q.options.some((opt: any) => typeof opt !== 'string' || !opt.trim() || opt.length > MAX_OPTION_TEXT_LENGTH)) {
      return `Each option must be under ${MAX_OPTION_TEXT_LENGTH} characters`;
    }
    if (!q.correctOption || !q.options.includes(q.correctOption)) {
      return `The correct option must be one of the provided choices`;
    }
  }
  return null;
};

// Create a custom quiz
export const createQuiz = async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, questions, priceCoins, isPublishedToMarketplace } = req.body;

    if (!title || typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ success: false, message: `Title is required and must be under ${MAX_TITLE_LENGTH} characters` });
    }

    if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
      return res.status(400).json({ success: false, message: `Description must be under ${MAX_DESCRIPTION_LENGTH} characters` });
    }

    const questionsError = validateQuestions(questions);
    if (questionsError) {
      return res.status(400).json({ success: false, message: questionsError });
    }

    if (priceCoins !== undefined && (typeof priceCoins !== 'number' || !Number.isFinite(priceCoins) || priceCoins < 0 || priceCoins > 10)) {
      return res.status(400).json({ success: false, message: 'Price must be a number between 0 and 10 coins' });
    }

    const quiz = await Quiz.create({
      title,
      description,
      creator: req.userId,
      questions,
      priceCoins: priceCoins || 0,
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
    const { title, description, questions, priceCoins, isPublishedToMarketplace } = req.body;
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
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
        return res.status(400).json({ success: false, message: `Title must be non-empty and under ${MAX_TITLE_LENGTH} characters` });
      }
      quiz.title = title;
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, message: `Description must be under ${MAX_DESCRIPTION_LENGTH} characters` });
      }
      quiz.description = description;
    }
    if (priceCoins !== undefined) {
      if (typeof priceCoins !== 'number' || !Number.isFinite(priceCoins) || priceCoins < 0 || priceCoins > 10) {
        return res.status(400).json({ success: false, message: 'Price must be a number between 0 and 10 coins' });
      }
      quiz.priceCoins = priceCoins;
    }
    if (isPublishedToMarketplace !== undefined) quiz.isPublishedToMarketplace = !!isPublishedToMarketplace;

    if (questions !== undefined) {
      const questionsError = validateQuestions(questions);
      if (questionsError) {
        return res.status(400).json({ success: false, message: questionsError });
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

    const userId = req.userId;
    const isCreator = quiz.creator && (quiz.creator as any)._id?.toString() === userId;

    // Only the creator, default/system quizzes, or a confirmed purchaser get
    // the answer key. Everyone else (browsing the marketplace, deciding
    // whether to buy) gets questions/options without `correctOption`.
    let canSeeAnswers = !!quiz.isDefault || !!isCreator;
    if (!canSeeAnswers) {
      const [purchase, user] = await Promise.all([
        QuizPurchase.findOne({ buyer: userId, quiz: quiz._id }),
        User.findById(userId)
      ]);
      canSeeAnswers = !!purchase || !!user?.isAdmin;
    }

    if (canSeeAnswers) {
      return res.status(200).json({ success: true, quiz });
    }

    const sanitizedQuiz = quiz.toObject();
    sanitizedQuiz.questions = sanitizedQuiz.questions.map((q: any) => {
      const { correctOption, ...rest } = q;
      return rest;
    });

    return res.status(200).json({ success: true, quiz: sanitizedQuiz });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
