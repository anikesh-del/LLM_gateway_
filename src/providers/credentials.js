import { env } from '../config/env.js';

/**
 * Returns credentials and base URL for a given provider.
 * Keeps real provider secrets server-side only.
 * @param {string} [provider='gemini']
 * @returns {{ apiKey: string, baseURL: string }}
 */
export function getProviderCredentials(provider = 'gemini') {
  if (provider === 'gemini') {
    return {
      apiKey: env.GEMINI_API_KEY,
      baseURL: env.GEMINI_BASE_URL
    };
  }
  
  if (provider === 'groq' && env.GROQ_API_KEY) {
    return {
      apiKey: env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1/'
    };
  }

  if (provider === 'openrouter' && env.OPENROUTER_API_KEY) {
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1/'
    };
  }

  throw new Error(`Unsupported or unconfigured provider: ${provider}`);
}
