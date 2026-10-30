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
  DOCUMENT_STORAGE_PROVIDER: z.enum(['local', 's3']).optional(),
  PRESCRIPTION_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  PRESCRIPTION_STORAGE_DIR: z.string().min(1).default('./storage/prescriptions'),
  PRESCRIPTION_S3_ENDPOINT: z.string().url().optional(),
  PRESCRIPTION_S3_REGION: z.string().min(1).default('auto'),
  PRESCRIPTION_S3_BUCKET: z.string().min(1).optional(),
  PRESCRIPTION_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  PRESCRIPTION_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  PRESCRIPTION_S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  PRESCRIPTION_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(10 * 1024 * 1024).default(5 * 1024 * 1024),
  PRESCRIPTION_OCR_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  PRESCRIPTION_OCR_PROVIDER: z.enum(['paddleocr']).default('paddleocr'),
  PRESCRIPTION_OCR_BASE_URL: z.string().url().optional(),
  PRESCRIPTION_OCR_API_KEY: z.string().min(1).optional(),
  PRESCRIPTION_OCR_MODEL: z.string().min(1).optional(),
  PRESCRIPTION_OCR_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(120_000),
  PRESCRIPTION_STRUCTURING_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  PRESCRIPTION_STRUCTURING_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  PRESCRIPTION_STRUCTURING_API_KEY: z.string().min(1).optional(),
  PRESCRIPTION_STRUCTURING_MODEL: z.string().min(1).default('deepseek-flash'),
  PRESCRIPTION_STRUCTURING_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  MEDICAL_DOCUMENT_STRUCTURING_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  MEDICAL_DOCUMENT_STRUCTURING_BASE_URL: z.string().url().optional(),
  MEDICAL_DOCUMENT_STRUCTURING_API_KEY: z.string().min(1).optional(),
  MEDICAL_DOCUMENT_STRUCTURING_MODEL: z.string().min(1).optional(),
  MEDICAL_DOCUMENT_STRUCTURING_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).optional(),
  LAB_PDF_STORAGE_DIR: z.string().min(1).default('./storage/labs'),
  LAB_PDF_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(25 * 1024 * 1024).default(10 * 1024 * 1024),
}).superRefine((value, context) => {
  if (value.PRESCRIPTION_OCR_ENABLED && !value.PRESCRIPTION_OCR_BASE_URL) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['PRESCRIPTION_OCR_BASE_URL'], message: 'Required when prescription OCR is enabled.' });
  }
  if (value.PRESCRIPTION_OCR_ENABLED && !value.PRESCRIPTION_OCR_API_KEY) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['PRESCRIPTION_OCR_API_KEY'], message: 'Required when prescription OCR is enabled.' });
  }
  if (value.PRESCRIPTION_STRUCTURING_ENABLED && !value.PRESCRIPTION_STRUCTURING_API_KEY) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['PRESCRIPTION_STRUCTURING_API_KEY'], message: 'Required when prescription text structuring is enabled.' });
  }
  if (value.MEDICAL_DOCUMENT_STRUCTURING_ENABLED && !(value.MEDICAL_DOCUMENT_STRUCTURING_API_KEY || value.PRESCRIPTION_STRUCTURING_API_KEY)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['MEDICAL_DOCUMENT_STRUCTURING_API_KEY'], message: 'A DeepSeek API key is required when medical document structuring is enabled.' });
  }
});

export const env = envSchema.parse(process.env);
export const documentStorageProvider = env.DOCUMENT_STORAGE_PROVIDER ?? env.PRESCRIPTION_STORAGE_PROVIDER;
export const medicalDocumentStructuring = {
  enabled: env.MEDICAL_DOCUMENT_STRUCTURING_ENABLED,
  baseUrl: env.MEDICAL_DOCUMENT_STRUCTURING_BASE_URL ?? env.PRESCRIPTION_STRUCTURING_BASE_URL,
  apiKey: env.MEDICAL_DOCUMENT_STRUCTURING_API_KEY ?? env.PRESCRIPTION_STRUCTURING_API_KEY,
  model: env.MEDICAL_DOCUMENT_STRUCTURING_MODEL ?? env.PRESCRIPTION_STRUCTURING_MODEL,
  timeoutMs: env.MEDICAL_DOCUMENT_STRUCTURING_TIMEOUT_MS ?? env.PRESCRIPTION_STRUCTURING_TIMEOUT_MS,
};
export const allowedOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim());
