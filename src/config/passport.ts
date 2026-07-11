import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { User } from '../models/User';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: `${BACKEND_URL}/api/auth/google/callback`,
        proxy: true
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          // Find or create user
          let user = await User.findOne({ googleId: profile.id });
          if (!user) {
            user = await User.findOne({ email: profile.emails?.[0].value });
            if (user) {
              // Update user with googleId
              user.googleId = profile.id;
              if (profile.photos?.[0].value) {
                user.avatarUrl = profile.photos[0].value;
              }
              await user.save();
            } else {
              user = await User.create({
                displayName: profile.displayName || profile.emails?.[0].value.split('@')[0] || 'User',
                email: profile.emails?.[0].value || '',
                googleId: profile.id,
                avatarUrl: profile.photos?.[0].value || '',
                isPremium: false,
                balance: 0,
                salesCount: 0
              });
            }
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
