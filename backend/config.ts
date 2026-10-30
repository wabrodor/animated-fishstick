import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AI_ENABLED: z.coerce.boolean().default(false),
  AI_PROVIDER: z.enum(['openai-compatible']).default('openai-compatible'),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).optional(),
  PRESCRIPTION_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  PRESCRIPTION_STORAGE_DIR: z.string().min(1).default('./storage/prescriptions'),
  PRESCRIPTION_S3_ENDPOINT: z.string().url().optional(),
  PRESCRIPTION_S3_REGION: z.string().min(1).default('auto'),
  PRESCRIPTION_S3_BUCKET: z.string().min(1).optional(),
  PRESCRIPTION_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  PRESCRIPTION_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  PRESCRIPTION_S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  PRESCRIPTION_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(10 * 1024 * 1024).default(5 * 1024 * 1024),
  LAB_PDF_STORAGE_DIR: z.string().min(1).default('./storage/labs'),
  LAB_PDF_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(25 * 1024 * 1024).default(10 * 1024 * 1024),
});

export const env = envSchema.parse(process.env);
export const allowedOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim());
