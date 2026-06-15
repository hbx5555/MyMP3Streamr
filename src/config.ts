import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),
  ADMIN_API_KEY: z.string().min(16),
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET_NAME: z.string().default(''),
  R2_PUBLIC_BASE_URL: z.string().optional().default(''),
  DEFAULT_STREAM_BITRATE: z.coerce.number().int().nonnegative().default(0),
  LOW_BANDWIDTH_BITRATE: z.coerce.number().int().positive().default(128),
  STREAM_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  YTDLP_COOKIES_BASE64: z.string().optional().default(''),
  LOG_LEVEL: z.string().default('info')
});

export type AppConfig = z.infer<typeof envSchema>;

export const config = envSchema.parse(process.env);
