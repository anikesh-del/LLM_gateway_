# AI-LOG.md: AI Usage and Engineering Log

## Which AI tools/models were used and for what
- Used Google Antigravity (Gemini 3.8 Flash) for scaffolding repository foundation, designing raw PostgreSQL schema, and writing migration scripts.
- Used Gemini 3.8 Flash for implementing Phase 2: constant-time admin authentication, `crypto.randomBytes` virtual key generator, and SHA-256 virtual key verification middleware.
- Used Gemini 3.8 Flash for implementing Phase 3: token estimation heuristic (`ceil(chars / 4)`), cost calculation in integer paise directly using Indian Rupees (INR) rates, OpenAI-compatible proxy client, `usage_logs` writer, and tracking headers.
- Used Gemini 3.8 Flash for implementing Phase 4: atomic budget reservation (`reserveBudget`), transactional settlement & refund (`settleBudget`), and 5-way parallel concurrency testing.
- Used Gemini 3.8 Flash for implementing Phase 5: resilience policy in `executeWithResilience` (overall deadline, bounded retry, jittered backoff, cheap-to-capable fallback, incremental reservation top-up, and mock resilience test suite).
- Used Gemini 3.8 Flash for implementing Phase 6: pure heuristic router `route()`, table-driven tests for every routing rule, budget reservation by routed model, and `scripts/replay.js` benchmark recording a verified 37.5% cost reduction across 30 varied prompts.
- Used Gemini 3.8 Flash for implementing Phase 7: admin usage reporting handler (`GET /usage`) with spend/token/model breakdown, and single-file vanilla JS developer test console (`public/index.html`).
- Implemented Circuit Breaker pattern (`src/gateway/circuitBreaker.js`) with tri-state state machine (`CLOSED`, `OPEN`, `HALF_OPEN`), single-probe canary recovery in `HALF_OPEN`, and automated unit test suite.

## Where the AI was wrong or misleading (and how it was caught)
1. **Circuit Breaker Deadlock in `HALF_OPEN`**:
   The AI's initial implementation of the circuit breaker transitioned from `OPEN` to `HALF_OPEN` and allowed one probe through. However, `isOpen()` was checked at the very top of `chatHandler.js` before body validation and budget reservation. When a probe request arrived with an invalid schema (400) or insufficient balance (402), the handler returned early without ever calling `recordSuccess()` or `recordFailure()`. As a result, the breaker was trapped in `HALF_OPEN` forever, causing every subsequent request to fail with 503 `circuit_open`.
   *Caught by*: Code walkthrough of the probe error paths. Fixed by adding `geminiBreaker.releaseProbe()` on all caller-side rejection paths (immediately returning the breaker to `OPEN` with expired cooldown for the next caller) and adding cooldown expiration inside `isOpen()` if an in-flight probe is abandoned.
2. **Model IDs Returned 404 Upstream**:
   The AI initially defaulted `.env.example` and `pricing.js` to `gemini-2.5-flash` and `gemini-2.5-pro`. When tested against Google's OpenAI-compatible endpoint, Google returned HTTP 404: *"This model models/gemini-2.5-flash is no longer available to new users."*
   *Caught by*: Testing live completions in the browser test console. Updated configuration to active models: `gemini-3.5-flash-lite` (Cheap) and `gemini-3.5-flash` (Capable).
3. **Pricing Source Mismatch**:
   The AI initially claimed pricing was "verified against official docs", but Google has not published separate 3.5 standalone pricing cards.
   *Caught by*: Auditing `pricing.js` against https://ai.google.dev/pricing. Clarified transparently in both `pricing.js` and `DECISIONS.md` that 3.5 rates are estimated surrogates based on Google's published Flash-Lite tier ($0.10/$0.40 per 1M) and Flash tier ($0.30/$2.50 per 1M) converted at ₹86/USD.

## Where the author overrode the AI (and why)
1. **Gateway-Owned Output Token Limits vs Client `max_tokens`**:
   The AI initially read `req.body.max_tokens` to calculate worst-case reservation costs. I overrode this because allowing clients to determine the reservation ceiling creates severe attack vectors: a caller could pass `max_tokens: 100000` to lock up massive budgets and block concurrent requests, or pass `max_tokens: 1` to bypass the budget check while consuming hundreds of tokens upstream. I mandated that the gateway must estimate and enforce its own output ceiling per tier (1000 for lite, 2500 for flash). The router inspects `body.max_tokens` only as an advisory signal of caller intent (>1024 routes to capable), while reservation and execution enforce gateway limits.
2. **Single-Statement Atomic SQL vs Two-Step Check-Then-Deduct**:
   The AI initially drafted a two-step pattern: query `SELECT spent_paise FROM api_keys` in JavaScript, check if `spent + estimate <= budget`, and then execute an `UPDATE`. I overrode this immediately because concurrent requests would pass the check simultaneously and cause account overdrafts. I insisted on a single atomic SQL statement: `UPDATE api_keys SET spent_paise = spent_paise + $1 WHERE id = $2 AND spent_paise + $1 <= budget_paise RETURNING id`, using integer paise throughout (no floats).
3. **Preventing Table Bloat on 402 Rejections**:
   The AI initially logged every 402 `budget_exceeded` rejection into PostgreSQL `usage_logs`. I overrode this because an exhausted key caught in a retry loop or DDoS script would generate massive write amplification and table bloat without any billable usage. 402 rejections now fail fast without inserting DB rows.

## Why the Circuit Breaker was added (Rationale beyond ARCHITECTURE.md)
While `ARCHITECTURE.md` outlined per-attempt timeouts, bounded retries, and fallbacks, it lacked protection against cascading failures during extended upstream provider outages. Without a circuit breaker, every incoming request would wait through timeout and retry loops (up to 30–60 seconds per request), exhausting Node's socket pool and holding PostgreSQL budget reservations unnecessarily.
Adding the in-memory `CircuitBreaker` (`CLOSED`, `OPEN`, `HALF_OPEN`) allows the gateway to:
- Detect provider collapse (5 consecutive transient errors) and fail fast in **0ms** with `503 Service Unavailable` and `Retry-After: 15`.
- Preserve database locks and user budget during outages.
- Safely test recovery with a single canary probe in `HALF_OPEN` before opening traffic.

## How control was kept over code not typed by hand
- **Secrets Protection**: Verified `.gitignore` prevents tracking `.env`. Audited git history with `git log -p | grep -iE "AIza|gw_[a-f0-9]{48}"` to ensure zero real credentials or virtual keys were committed.
- **Budget Verification**: Verified integer paise accounting and atomic SQL locking through a dedicated 5-way parallel concurrency test in `tests/budget.test.js`.
- **Sanitized Errors**: Inspected error mapping logic so upstream error bodies and keys are never forwarded to callers.

## Something learned from scratch and how
- Learned how modern multimodal reasoning models (such as `gemini-3.5-flash`) handle internal chain-of-thought tokens. Without setting `reasoning_effort: "low"` or budgeting adequate output tokens, internal thinking tokens consume the token budget before output generation completes, causing truncated outputs and latency spikes (~40s). Explicitly passing `reasoning_effort = 'low'` and reserving 2500 tokens resolved the truncation.
