# AI-LOG.md: AI Usage and Engineering Log

## AI Collaboration & Engineering Division of Responsibility

I architected, designed, and directed the entire implementation of this gateway from first principles. AI (Gemini 3.8 Flash via Google Antigravity) was used strictly as an interactive coding pair and accelerator for drafting boilerplate, generating test fixtures, and rapid prototyping under strict architectural constraints that I defined.

### How Engineering Responsibilities Were Divided:

#### 1. Architecture, System Design & Core Decisions (100% Human-Driven)
- **Zero ORM / Pure SQL Constraint**: Rejected heavy abstraction layers (Prisma/TypeORM) in favor of raw `pg` client to maintain complete visibility over connection pooling and SQL transaction boundaries.
- **Monetary Reserve-Then-Refund Pattern**: Formulated the reserve-then-refund lifecycle in integer paise to eliminate floating-point rounding errors and ensure concurrent overdrafts are impossible.
- **Atomic Concurrency Guarantee**: Designed the single-statement SQL locking update (`UPDATE api_keys SET spent_paise = spent_paise + $1 WHERE id = $2 AND spent_paise + $1 <= budget_paise RETURNING id`) using PostgreSQL row-level locks instead of non-atomic read-then-write code.
- **Gateway-Owned Token Ceilings**: Overrode the naive design of trusting client-supplied `max_tokens` to prevent callers from manipulating or exhausting budget reservations.
- **Circuit Breaker State Machine**: Introduced and designed the in-memory tri-state breaker (`CLOSED`, `OPEN`, `HALF_OPEN`) with explicit probe lifecycle management to protect against upstream outages.
- **Heuristic Router Design**: Established the zero-overhead deterministic heuristic rules (regex keyword matching, markdown detection, token estimation) rather than adding costly LLM-based routing.

#### 2. AI Accelerator & Pair-Programming Assistance
- **Boilerplate & Schema Scaffolding**: Accelerated drafting of Express route skeletons, Zod input validation schemas, and database migration SQL (`001_init.sql`).
- **Test Suite Drafting**: Generated initial Supertest mock server setups, test prompts, and boilerplate assertions across the 8 Vitest suites.
- **Syntax & API Probing**: Assisted in checking OpenAI-compatible chat completion payload formats and Google AI Studio parameter support.
- **Benchmark Prompt Compilation**: Assisted in synthesizing the 30 diverse prompts used in `scripts/replay.js` to simulate cost savings across short, coding, and reasoning categories.

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
