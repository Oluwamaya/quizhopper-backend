import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { User } from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import { getGlobalConfig } from '../models/AppConfig';
import { env } from './env';

const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const BACKEND_URL = env.BACKEND_URL;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: `${BACKEND_URL}/api/auth/google/callback`,
        proxy: true
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const emailEntry = profile.emails?.[0] as { value?: string; verified?: boolean } | undefined;
          const rawEmail = emailEntry?.value || '';
          const normalizedEmail = rawEmail.trim().toLowerCase();

          // Find existing account by Google ID first
          let user = await User.findOne({ googleId: profile.id });
          if (user) {
            if (normalizedEmail && user.email !== normalizedEmail) {
              user.email = normalizedEmail;
              await user.save();
            }
            return done(null, user);
          }

          if (!normalizedEmail) {
            return done(new Error('Google account did not provide an email address'), undefined);
          }

          // Case-insensitive email lookup so existing accounts (email/password
          // or legacy mixed-case Google records) link seamlessly to the same user
          user = await User.findOne({
            email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: 'i' }
          });

          if (user) {
            if (emailEntry?.verified === false) {
              return done(new Error('Google email address is not verified'), undefined);
            }
            user.googleId = profile.id;
            user.email = normalizedEmail;
            if (!user.avatarUrl && profile.photos?.[0]?.value) {
              user.avatarUrl = profile.photos[0].value;
            }
            await user.save();
            return done(null, user);
          }

          const config = await getGlobalConfig();
          const isFirstUser = (await User.countDocuments()) === 0;
          let baseName = (profile.displayName || normalizedEmail.split('@')[0] || 'User').trim().slice(0, 26);
          if (baseName.length < 2) baseName = 'Player';

          let finalDisplayName = baseName;
          const nameTaken = await User.exists({ displayName: finalDisplayName });
          if (nameTaken) {
            finalDisplayName = `${baseName.slice(0, 22)}_${Math.floor(100 + Math.random() * 900)}`;
          }

          user = await User.create({
            displayName: finalDisplayName,
            email: normalizedEmail,
            googleId: profile.id,
            avatarUrl: profile.photos?.[0]?.value || `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(finalDisplayName)}`,
            isAdmin: isFirstUser,
            isSuperAdmin: isFirstUser,
            isPremium: false,
            balance: 0,
            coins: config.signupCoinGift,
            salesCount: 0
          });

          if (config.signupCoinGift > 0) {
            await WalletTransaction.create({
              user: user._id,
              type: 'signup_bonus',
              coinsChange: config.signupCoinGift,
              amountMoney: 0,
              description: `Welcome bonus: ${config.signupCoinGift} free hosting coins`,
              status: 'completed'
            });
          }

          return done(null, user);
        } catch (error: any) {
          return done(error, undefined);
        }
      }
    )
  );
} else {
  console.warn(
    'WARNING: Google Client ID or Secret is missing in env. Google login will be disabled. Developer mock login will be active.'
  );
}

// Serialize/deserialize for passport session integration if needed
passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});
