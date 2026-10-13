// Lightweight moderation for in-game chat, aimed at catching ordinary
// profanity and flooding in a live, casual, multi-age-group setting
// (schools, churches, parties) — not a serious adversary deterrent. A
// determined user can always work around a word-list filter with spacing
// or substitutions; this exists to catch ordinary typing, not to be
// airtight. Messages are matched and censored (not rejected outright) so
// an accidental or borderline word doesn't block an otherwise fine message.
const FLAGGED_WORDS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy',
  'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut', 'rape'
];

const FLAGGED_PATTERN = new RegExp(`\\b(${FLAGGED_WORDS.join('|')})\\b`, 'gi');

// Replaces every letter but the first in a matched word with "*", e.g.
// "shit" -> "s***". Keeps the message's shape readable without the slur.
export const censorMessage = (text: string): string => {
  return text.replace(FLAGGED_PATTERN, (match) => match[0] + '*'.repeat(match.length - 1));
};

const MAX_MESSAGE_LENGTH = 200;

// Structural validation only (length, non-empty) — censoring is handled
// separately by censorMessage so a flagged word never blocks a message
// outright.
export const validateChatMessage = (text: any): string | null => {
  if (typeof text !== 'string' || !text.trim()) {
    return 'Message cannot be empty';
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return `Message must be under ${MAX_MESSAGE_LENGTH} characters`;
  }
  return null;
};

// Per-socket sliding-window rate limit — in-memory, cleared on disconnect
// (see gameSocket.ts). Deliberately not room-scoped: it's about stopping
// one connection from flooding, not capping a room's total chat volume.
const RATE_LIMIT_MAX_MESSAGES = 5;
const RATE_LIMIT_WINDOW_MS = 10000;
const recentMessageTimestamps: { [socketId: string]: number[] } = {};

export const isChatRateLimited = (socketId: string): boolean => {
  const now = Date.now();
  const timestamps = (recentMessageTimestamps[socketId] || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
    recentMessageTimestamps[socketId] = timestamps;
    return true;
  }
  timestamps.push(now);
  recentMessageTimestamps[socketId] = timestamps;
  return false;
};

export const clearChatRateLimit = (socketId: string): void => {
  delete recentMessageTimestamps[socketId];
};
