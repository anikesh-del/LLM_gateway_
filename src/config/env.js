import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env into process.env before validation
dotenv.config();

// Construct DATABASE_URL from discrete DB_* env vars if not directly provided
if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const user = process.env.DB_USERNAME || 'postgres';
  const pass = process.env.DB_PASSWORD ? `:${process.env.DB_PASSWORD}` : '';
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || 5432;
  const dbName = process.env.DB_NAME || 'llm_gateway2';
  process.env.DATABASE_URL = `postgresql://${user}${pass}@${host}:${port}/${dbName}`;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL or DB_* credentials must be provided'),
  ADMIN_SECRET: z.string().min(16, 'ADMIN_SECRET must be at least 16 characters long'),
  
  DEFAULT_PROVIDER: z.string().default('gemini'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  
  MODEL_CHEAP: z.string().default('gemini-3.5-flash-lite'),
  MODEL_CAPABLE: z.string().default('gemini-3.5-flash'),
  
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  REQUEST_DEADLINE_MS: z.coerce.number().int().positive().default(60000),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  
  ROUTER_LONG_PROMPT_TOKENS: z.coerce.number().int().positive().default(1500),
  ROUTER_CAPABLE_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  
  // Optional secondary providers (disabled by default)
  GROQ_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('CRITICAL: Environment validation failed:');
  for (const issue of parsed.error.issues) {
    console.error(`  - [${issue.path.join('.')}] ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
