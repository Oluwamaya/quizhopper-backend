import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

// Fail fast if required secrets are missing or too weak to be safe.
// Do NOT fall back to hardcoded defaults here — a silently-applied default
// secret in production means anyone reading the source can forge tokens.
function requireEnv(name: string, minLength = 1): string {
  const value = process.env[name];
  if (!value || value.trim().length < minLength) {
    console.error(
      `FATAL: Environment variable ${name} is missing or too short (min ${minLength} chars). ` +
        `Set it in your .env file before starting the server.`
    );
    process.exit(1);
  }
  return value;
}

// In development only, allow a generated-on-the-fly secret so the app is
// still runnable without a fully populated .env — but never in production.
function requireEnvOrDevFallback(name: string, devFallback: string, minLength = 1): string {
  const value = process.env[name];
  if (value && value.trim().length >= minLength) return value;
  if (isProduction) {
    console.error(`FATAL: Environment variable ${name} is missing or too short in production.`);
    process.exit(1);
  }
  console.warn(`WARNING: ${name} not set — using an insecure development-only default. Do not deploy like this.`);
  return devFallback;
}

export const env = {
  isProduction,
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 5000,

  MONGODB_URI: requireEnv('MONGODB_URI', 10),
  JWT_SECRET: requireEnvOrDevFallback('JWT_SECRET', 'dev_only_insecure_jwt_secret_do_not_use_in_prod', 16),
  COOKIE_KEY: requireEnvOrDevFallback('COOKIE_KEY', 'dev_only_insecure_cookie_key_do_not_use_in_prod', 16),

  // CLIENT_URL may be a single origin or a comma-separated list (e.g. a
  // staging + production frontend). CLIENT_URL stays the first entry for
  // building absolute links (OAuth redirects, password reset links);
  // CLIENT_URLS is the full allow-list for CORS checks.
  CLIENT_URL: (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim(),
  CLIENT_URLS: (process.env.CLIENT_URL || 'http://localhost:5173')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean),
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:5000',

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',

  // Paystack live/test mode is an explicit switch, independent of NODE_ENV —
  // this lets the app run in production (NODE_ENV=production, all the
  // production hardening active) while still safely processing test-mode
  // payments, until PAYSTACK_LIVE_MODE is deliberately flipped on. Real
  // money only moves once that flag is true AND the live keys are set.
  PAYSTACK_LIVE_MODE: process.env.PAYSTACK_LIVE_MODE === 'true',
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_LIVE_MODE === 'true'
    ? requireEnv('PAYSTACK_SECRET_LIVE_KEY', 10)
    : process.env.PAYSTACK_SECRET_TEST_KEY || '',
  PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_LIVE_MODE === 'true'
    ? requireEnv('PAYSTACK_PUBLIC_LIVE_KEY', 10)
    : process.env.PAYSTACK_PUBLIC_TEST_KEY || '',

  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_EMAIL: process.env.VAPID_EMAIL || 'mailto:admin@quizhopper.com',

  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  // Optional — local dev Redis typically has no password and no TLS.
  // Managed providers (Upstash, etc.) require both; set REDIS_PASSWORD and
  // REDIS_TLS=true for those. TLS is an explicit switch rather than being
  // inferred from the password being set, so behavior is never a surprise.
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
  REDIS_TLS: process.env.REDIS_TLS === 'true',

  // Cloudinary object storage for user-uploaded files. Optional —
  // support-ticket uploads return a 503 if these aren't set rather than
  // failing the whole app at boot.
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || ''
};
