import { Schema, model, Document } from 'mongoose';

export interface IAppConfig extends Document {
  key: string; // e.g. "global"
  commissionRate: number; // e.g. 0.15 (15%)
  freeTierLimit: number; // e.g. 10 players
  coinPrice: number; // exchange rate of 1 coin in dollars (e.g. 1.00)
  updatedAt: Date;
}

const AppConfigSchema = new Schema<IAppConfig>({
  key: { type: String, default: 'global', unique: true },
  commissionRate: { type: Number, default: 0.15 },
  freeTierLimit: { type: Number, default: 10 },
  coinPrice: { type: Number, default: 1.00 },
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
      coinPrice: 1.00
    });
  }
  return config;
};
