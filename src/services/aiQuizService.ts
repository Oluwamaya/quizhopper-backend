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
- The 3 incorrect options must be real, specific, plausible distractors a knowledgeable person could genuinely be tempted by — not joke answers, not vague filler, and not obviously-wrong options that give the game away on sight.
- The correct answer must never be identifiable by being longer, more specific, or more detailed than the 3 distractors — keep all 4 options similar in length and style so nothing stands out structurally.
- Do not repeat questions or rephrase the same fact twice.
- Do not reveal or hint at the answer within the question text itself.
- Match question depth and specificity to the requested difficulty — treat these as strict, not a suggestion:
  - easy: broadly known facts a casual player would know without specialist knowledge.
  - medium: requires real familiarity with the topic — not obscure, but not common knowledge either. Distractors should be genuinely tempting to someone who only half-remembers the subject.
  - hard: specific, nuanced facts that only someone with real expertise or deep familiarity would reliably know. Distractors should be the kind of plausible-sounding near-misses that trip up all but the most knowledgeable players — close dates, similar names, related-but-wrong facts. A hard question that most people could still guess correctly has failed the brief.
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

  // When asked for a topic it won't engage with (e.g. explicit sexual
  // content), Claude doesn't hard-fail the request — forced into this
  // response schema, it instead produces a "question" that IS its refusal
  // text, padded out with filler/duplicate options just to satisfy the
  // shape (4 distinct options, exactly N questions). That passes the Zod
  // schema above (correct lengths, correctOption technically matches one
  // option) while being worthless as a quiz question — and because it
  // "succeeds", the coin charge was never refunded and the refusal text
  // got saved as if it were real content. Two checks below catch this
  // before it ever reaches the client or DB.
  const REFUSAL_PATTERN = /\b(i can'?t help|i cannot help|i'?m not able to|i'?m unable to|i won'?t|as an ai|i can'?t (create|generate|write|provide)|i cannot (create|generate|write|provide))\b/i;

  for (const q of questions) {
    if (!q.options.includes(q.correctOption)) {
      throw new Error('AI generation produced an invalid answer key. Please try again.');
    }

    // A genuine quiz question never repeats an option — padding with
    // duplicates (e.g. "N/A", "N/A", "N/A") is the clearest structural
    // fingerprint of a declined/degenerate response.
    const normalizedOptions = q.options.map((opt) => opt.trim().toLowerCase());
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      throw new Error('AI declined to generate content for this topic. Please try a different topic or description.');
    }

    if (REFUSAL_PATTERN.test(q.question)) {
      throw new Error('AI declined to generate content for this topic. Please try a different topic or description.');
    }
  }

  return questions.map((q) => ({
    question: q.question,
    // LLMs reliably favor certain answer positions (first slot being the
    // most common bias) regardless of prompting — a model-dependent
    // instruction isn't something to rely on for this. Shuffling here
    // guarantees a genuinely random position every time; correctOption is
    // matched by text everywhere downstream (quiz-taking, scoring,
    // storage), never by index, so reordering options is always safe.
    options: shuffle(q.options),
    correctOption: q.correctOption,
    timeLimit: TIME_LIMIT_BY_DIFFICULTY[difficulty]
  }));
};

const shuffle = <T,>(arr: T[]): T[] => {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
