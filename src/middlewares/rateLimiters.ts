import rateLimit from 'express-rate-limit';

// Applied globally to /api — generous ceiling to stop scraping/abuse without
// bothering normal usage.
export const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});

// Tight limiter for credential-guessing surfaces (register/login/admin-login/
// password reset/dev-login).
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' }
});

// File upload endpoint — cheap to abuse for disk-fill DoS.
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads. Please try again later.' }
});

// Paystack init/verify — throttles both API-quota abuse against Paystack and
// (now that the fallback credit is gone) brute-force reference guessing.
export const paystackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many wallet requests. Please try again later.' }
});

// AI quiz generation — each request costs real money against the Anthropic
// API on top of the coin charge, so this stays tight regardless of a user's
// coin balance.
export const aiGenerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI generation requests. Please try again later.' }
});
