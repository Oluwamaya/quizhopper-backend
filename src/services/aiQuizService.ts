import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../config/env';

const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

if (!env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set — AI quiz generation will return 503 until it is configured.');
}

export const isAiGenerationConfigured = (): boolean => !!client;

export type QuizDifficulty = 'easy' | 'medium' | 'hard';

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correctOption: string;
  timeLimit: number;
}

// Harder questions get more thinking time, not less.
const TIME_LIMIT_BY_DIFFICULTY: Record<QuizDifficulty, number> = {
  easy: 10,
  medium: 15,
  hard: 20
};

const QuestionSchema = z.object({
  question: z.string().min(5).max(300),
  options: z.array(z.string().min(1).max(150)).length(4),
  correctOption: z.string().min(1).max(150)
});

interface GenerateParams {
  topic: string;
  description: string;
  numQuestions: number;
  difficulty: QuizDifficulty;
}

export const generateQuizQuestions = async ({
  topic,
  description,
  numQuestions,
  difficulty
}: GenerateParams): Promise<GeneratedQuestion[]> => {
  if (!client) {
    throw new Error('AI quiz generation is not configured');
  }

  const OutputSchema = z.object({
    questions: z.array(QuestionSchema).length(numQuestions)
  });

  const systemPrompt = `You are an expert trivia and quiz question writer. You generate multiple-choice quiz questions that are strictly and exclusively about the exact topic a user gives you.

Rules you must always follow:
- Every question must be directly, factually relevant to the given topic and description. Do not include generic, unrelated, or tangential questions.
- Each question must have exactly 4 distinct answer options.
- Exactly one of the 4 options must be correct, and "correctOption" must match that option's text verbatim, character for character.
- The 3 incorrect options must be plausible but clearly wrong to someone who knows the topic — no joke answers, no options that are obviously silly filler.
- Do not repeat questions or rephrase the same fact twice.
- Do not reveal or hint at the answer within the question text itself.
- Match question depth and specificity to the requested difficulty:
  - easy: broadly known facts, suitable for beginners or casual players.
  - medium: moderately detailed knowledge, requires some familiarity with the topic.
  - hard: specific, nuanced, or advanced facts that only someone knowledgeable would know.
- Write questions and options in clear, natural English, each under 150 characters.`;

  const userPrompt = `Generate exactly ${numQuestions} multiple-choice quiz questions.

Topic: ${topic}
Additional description/context: ${description || '(none provided — rely on the topic alone)'}
Difficulty: ${difficulty}`;

  const response = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: Math.min(16000, 1500 + numQuestions * 400),
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(OutputSchema)
    }
  });

  if (!response.parsed_output) {
    throw new Error('AI generation did not return valid output. Please try again.');
  }

  const { questions } = response.parsed_output;

  // Defense in depth: the schema guarantees shape, not cross-field
  // consistency — confirm every correctOption is genuinely one of that
  // question's own options before this ever reaches the client or DB.
  for (const q of questions) {
    if (!q.options.includes(q.correctOption)) {
      throw new Error('AI generation produced an invalid answer key. Please try again.');
    }
  }

  return questions.map((q) => ({
    question: q.question,
    options: q.options,
    correctOption: q.correctOption,
    timeLimit: TIME_LIMIT_BY_DIFFICULTY[difficulty]
  }));
};
