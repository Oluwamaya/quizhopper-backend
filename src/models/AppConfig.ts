import { Schema, model, Document } from 'mongoose';

export interface IAppConfig extends Document {
  key: string; // e.g. "global"
  commissionRate: number; // e.g. 0.15 (15%)
  freeTierLimit: number; // e.g. 10 players
  coinPrice: number; // exchange rate of 1 coin in currency (e.g. 200 or 1.00)
  quizPriceCoins: number; // default price of marketplace quizzes in coins (e.g. 5)
  sellerCoinShare: number; // seller payout in coins per sale (e.g. 3)
  platformCoinFee: number; // platform fee in coins per sale (e.g. 2)
  updatedAt: Date;
}

const AppConfigSchema = new Schema<IAppConfig>({
  key: { type: String, default: 'global', unique: true },
  commissionRate: { type: Number, default: 0.15 },
  freeTierLimit: { type: Number, default: 10 },
  coinPrice: { type: Number, default: 200 },
  quizPriceCoins: { type: Number, default: 5 },
  sellerCoinShare: { type: Number, default: 3 },
  platformCoinFee: { type: Number, default: 2 },
  updatedAt: { type: Date, default: Date.now }
});

export const AppConfig = model<IAppConfig>('AppConfig', AppConfigSchema);

// Helper to fetch global configuration with defaults
export const getGlobalConfig = async (): Promise<IAppConfig> => {
  let config = await AppConfig.findOne({ key: 'global' });
  if (!config) {
    config = await AppConfig.create({
      key: 'global',
      commissionRate: 0.15,
      freeTierLimit: 10,
      coinPrice: 200,
      quizPriceCoins: 5,
      sellerCoinShare: 3,
      platformCoinFee: 2
    });
  }
  return config;
};
