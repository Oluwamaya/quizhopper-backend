import { Request, Response, NextFunction } from 'express';

// Known AI training/scraping bots and automated site-cloning tools.
// Legitimate browsers, mobile webviews, Paystack webhooks, and uptime monitors
// are never matched by this list.
const BLOCKED_BOT_PATTERN = new RegExp(
  [
    'GPTBot',
    'ChatGPT-User',
    'OAI-SearchBot',
    'ClaudeBot',
    'Claude-Web',
    'anthropic-ai',
    'CCBot',
    'Google-Extended',
    'Bytespider',
    'PerplexityBot',
    'Perplexity-User',
    'Diffbot',
    'Meta-ExternalAgent',
    'Meta-ExternalFetcher',
    'FacebookBot',
    'cohere-ai',
    'Amazonbot',
    'Applebot-Extended',
    'YouBot',
    'Omgilibot',
    'Scrapy',
    'HTTrack',
    'WebCopier',
    'SiteSucker',
    'Offline Explorer',
    'Teleport Pro',
    'WebZIP',
    'wget'
  ].join('|'),
  'i'
);

// Paths that receive legitimate server-to-server traffic (payment webhooks, health checks)
const EXEMPT_PATHS = ['/health', '/robots.txt', '/api/wallet/paystack/webhook'];

export const blockAiScrapersAndCloners = (req: Request, res: Response, next: NextFunction) => {
  if (EXEMPT_PATHS.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }

  const ua = req.headers['user-agent'] || '';
  if (ua && BLOCKED_BOT_PATTERN.test(ua)) {
    return res.status(403).json({
      success: false,
      message: 'Automated scraping and AI crawling are not permitted.'
    });
  }

  next();
};

export const apiHardeningHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Tell crawlers & AI agents not to index, archive, or train on API responses
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noai, noimageai');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Sensitive endpoints must never be cached by proxies or shared browsers
  if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/admin') || req.path.startsWith('/api/wallet')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
};
