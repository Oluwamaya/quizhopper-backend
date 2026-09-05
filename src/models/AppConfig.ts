import { Schema, model, Document } from 'mongoose';

export interface IAppConfig extends Document {
  key: string; // e.g. "global"
  freeTierLimit: number; // e.g. 5 players hosted for free
  extraPlayerCoinCost: number; // coins charged per player above the free tier (e.g. 2)
  coinPrice: number; // exchange rate of 1 coin in currency (e.g. 200 or 1.00)
  quizPriceCoins: number; // default price of marketplace quizzes in coins (e.g. 5)
  signupCoinGift: number; // coins automatically granted to every new user on signup (e.g. 10)
  aiGenerationCoinCost: number; // coins charged per AI quiz generation (e.g. 5)
  updatedAt: Date;
}

const AppConfigSchema = new Schema<IAppConfig>({
  key: { type: String, default: 'global', unique: true },
  freeTierLimit: { type: Number, default: 5 },
  extraPlayerCoinCost: { type: Number, default: 2 },
  coinPrice: { type: Number, default: 200 },
  quizPriceCoins: { type: Number, default: 5 },
  signupCoinGift: { type: Number, default: 10 },
  aiGenerationCoinCost: { type: Number, default: 5 },
  updatedAt: { type: Date, default: Date.now }
});

export const AppConfig = model<IAppConfig>('AppConfig', AppConfigSchema);

// Helper to fetch global configuration with defaults
export const getGlobalConfig = async (): Promise<IAppConfig> => {
  let config = await AppConfig.findOne({ key: 'global' });
  if (!config) {
    config = await AppConfig.create({
      key: 'global',
      freeTierLimit: 5,
      extraPlayerCoinCost: 2,
      coinPrice: 200,
      quizPriceCoins: 5,
      signupCoinGift: 10,
      aiGenerationCoinCost: 5
    });
  }
  return config;
};
