import { getProviderCredentials } from './credentials.js';

/**
 * Call an OpenAI-compatible chat completions endpoint.
 * Non-streaming only.
 * 
 * @param {Object} options
 * @param {string} options.model
 * @param {Array} options.messages
 * @param {number} [options.max_tokens]
 * @param {number} [options.temperature]
 * @param {string} [options.provider='gemini']
 * @param {number} [options.timeoutMs=20000]
 * @param {string} [options.overrideBaseURL]
 * @param {string} [options.overrideApiKey]
 * @returns {Promise<{ status: number, data: any, headers: Headers }>}
 */
export async function callOpenAICompatible({
  model,
  messages,
  max_tokens,
  temperature,
  provider = 'gemini',
  timeoutMs = 20000,
  overrideBaseURL,
  overrideApiKey
}) {
  const creds = overrideBaseURL
    ? { baseURL: overrideBaseURL, apiKey: overrideApiKey || 'mock-key' }
    : getProviderCredentials(provider);

  // Normalize baseURL to end with a slash
  const baseURL = creds.baseURL.endsWith('/') ? creds.baseURL : `${creds.baseURL}/`;
  const url = `${baseURL}chat/completions`;

  const payload = {
    model,
    messages
  };

  if (typeof max_tokens === 'number') {
    payload.max_tokens = max_tokens;
  }
  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }
  // For Gemini reasoning models, cap reasoning_effort to "low" to prevent
  // high latency and prevent internal thought tokens from starving the response.
  if (provider === 'gemini' && model.includes('flash') && !model.includes('lite')) {
    payload.reasoning_effort = 'low';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timer);

    const data = await response.json().catch(() => null);

    return {
      status: response.status,
      data,
      headers: response.headers
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Provider call timed out after ${timeoutMs}ms`);
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
}
