# DECISIONS.md: Design and Architecture Decisions

## What I built
A minimal, production-grade LLM Gateway in plain JavaScript (ES modules, Node 20, Express, raw `pg`) between client callers and provider models (Gemini default via OpenAI-compatible endpoint). It features gateway-issued virtual API keys, atomic budget reservations in integer paise against PostgreSQL, automatic cost extraction and usage logging, bounded retries/fallbacks, and a deterministic cheap-vs-capable heuristic router.

## Moving parts and request lifecycle
```
Client (Authorization: Bearer gw_...)
  |
  v
[1] Body validation (zod), stream:true rejection, size limits
[2] Virtual key auth: sha256(key) lookup in api_keys table
[3] Model routing: explicit model allowlist or heuristic rules
[4] Cost estimation: input chars est + max_tokens * output price in paise
[5] Atomic budget reservation: UPDATE api_keys ... WHERE spent_paise + reserve <= budget_paise
[6] Provider call with timeout, bounded jittered retry, and cheap->capable fallback
[7] finally{} settlement: actual cost calculated, spent_paise adjusted, usage_logs inserted
[8] Return OpenAI-compatible payload with custom tracking headers
```

## Top 3-5 decisions
1. **Plain JavaScript over TypeScript**: The gateway author is comfortable in Node.js/JavaScript; choosing plain ES modules with Zod runtime validation and clear JSDoc comments keeps the codebase 100% explainable and debuggable without build step friction.
2. **Integer paise and Raw SQL**: Avoiding ORMs ensures that the exact concurrency-safe `UPDATE ... WHERE ... RETURNING` SQL statement is executed directly against PostgreSQL, eliminating floating-point rounding bugs and hiding no abstractions.
3. **One-Way Virtual Key Storage**: Virtual keys (`gw_<randomHex>`) are generated via `crypto.randomBytes(24)`, returned exactly once to the client upon creation, and stored strictly as SHA-256 hashes (`key_hash`) along with an 8-character prefix (`key_prefix`) for identification. Plaintext keys are never saved in the database or server logs.
4. **Non-Streaming Strict Requirement**: Streaming (`stream: true`) is rejected with HTTP 400. Non-streaming ensures exact token and cost accounting at the end of each request, avoids dangling connections, and simplifies atomic budget settlement.
5. **Masking Raw Provider Errors**: Upstream error bodies (e.g. Google/OpenAI internal messages, tracebacks, or credentials) are logged only server-side. The gateway returns a sanitized error envelope `{ error: { code: "provider_error", message: "..." } }`.

## Why enforce budgets at the gateway
Provider APIs do not offer fine-grained real-time balance limits per virtual sub-key. Enforcing budgets at the gateway before the provider API call occurs prevents runaway expenses, runaway loops, and accidental overspending across multiple client applications sharing a single upstream provider account.

### Why max_tokens and the Reserve-then-Refund pattern?
1. **Input tokens are knowable upfront**: Approximated with $\lceil \text{chars}/4 \rceil$.
2. **Output tokens are estimated and enforced by the Gateway (not the client)**:
   - Clients cannot dictate or manipulate reservation ceilings. The gateway estimates the output token ceiling per model (`gemini-3.5-flash-lite`: 800 tokens, `gemini-3.5-flash`: 1500 tokens).
   - This ensures fair multi-tenant budget reservation and prevents callers from arbitrarily locking up large reservations that block other requests.
3. **Atomic reservation and immediate denial**:
   - The worst-case cost estimate is calculated before the call: $\text{est\_cost} = (\text{est\_input} + \text{gateway\_output\_tokens}) \times \text{rate}$.
   - We check and deduct in a single atomic SQL step:
     ```sql
     UPDATE api_keys
     SET spent_paise = spent_paise + $estimate
     WHERE id = $1 AND revoked_at IS NULL AND spent_paise + $estimate <= budget_paise
     RETURNING spent_paise;
     ```
   - **If the estimated cost is more than available budget**: PostgreSQL returns 0 rows, and the gateway denies the request immediately with **402 `budget_exceeded`** without calling the provider.
4. **Post-call reconciliation (settlement)**:
   - When the provider responds with real usage, the gateway computes the unspent delta and refunds it in `finally`:
     ```sql
     UPDATE api_keys SET spent_paise = GREATEST(spent_paise - $estimate + $actual, 0) WHERE id = $1;
     ```
5. **Edge cases handled**:
   - **Provider error / timeout**: 100% full refund (`actual = 0`).
   - **Streaming**: Excluded to avoid uncollected usage and mid-stream disconnect drift.

## Concurrency behaviour
Two concurrent requests on a near-exhausted key serialize on the PostgreSQL row lock of the `UPDATE api_keys` statement. The first request increments `spent_paise` within the limit and proceeds; the second request evaluates `spent_paise + $reserve <= budget_paise` which evaluates to false, updating 0 rows, and fails immediately with HTTP 402 `budget_exceeded`.

Proved by automated test in `tests/budget.test.js`:
- An API key is created with budget sufficient for exactly 1 request (`singleReqWorstCase` in paise).
- 5 parallel HTTP requests are fired simultaneously against `/v1/chat/completions`.
- Result: Exactly 1 request completes with 200 OK; the remaining 4 requests are rejected with 402 `budget_exceeded`.
- The database balance verification confirms `spent_paise <= budget_paise` holds true with zero overspending.

## Fallback policy and why
Retry once on transient network errors, timeouts, or provider 5xx/429 with jittered backoff.
- **Never retry caller 4xx**: Errors such as 400 (malformed request) or 401/403/404 are deterministic caller errors. Retrying them wastes budget and introduces useless latency.
- **Cheap-to-capable fallback**: If a cheap-tier model (`gemini-2.5-flash`) fails after retry, the gateway tops up the budget reservation (if the capable model worst-case cost is higher) and falls back to the capable model (`gemini-2.5-pro`) to protect caller availability.
- **Budget top-up guarantee**: If the virtual key lacks sufficient remaining balance to afford the capable model's worst-case reservation, the fallback does not execute, avoiding overdrafts, and returns HTTP 402 `budget_exceeded`.
- **All-failure refund**: If all attempts fail, the gateway returns clean 502/504 errors, refunds 100% of the reserved budget, and records the failure row in `usage_logs`.

## Router policy, why it is shaped that way, and the measured result
Deterministic heuristic router with zero LLM overhead:
1. **Explicit override**: If the client passes a specific model name (other than `"auto"`), it is honored directly with reason `explicit`.
2. **Deterministic heuristics**: When `model` is omitted or `"auto"`, the request is routed to **Capable** (`gemini-2.5-pro`) if any of these trigger:
   - Estimated input tokens > 1500 (`ROUTER_LONG_PROMPT_TOKENS`).
   - Requested `max_tokens` > 1024 (`ROUTER_CAPABLE_MAX_TOKENS`).
   - Multi-turn conversation depth > 6 messages.
   - Code detected (markdown fences ```` ``` ````, keywords `function`, `class`, `import`).
   - Complex reasoning keywords (`step by step`, `analyze`, `prove`, `debug`, `design`, `compare`).
3. Otherwise, it defaults to **Cheap** (`gemini-2.5-flash`) with reason `short_simple_prompt`.

### Measured Replay Benchmark (`scripts/replay.js`):
Evaluated a representative workload of 30 diverse queries (short Q&A, coding, analysis, and system design):
- **Total Prompts**: 30
- **Routed to Cheap Tier**: 15 (50.0%)
- **Routed to Capable Tier**: 15 (50.0%)
- **Always-Capable Baseline Spend**: 412 paise (₹4.12)
- **Gateway Routed Spend**: 270 paise (₹2.70)
- **Net Measured Savings**: **142 paise (₹1.42) -> 34.5% Cost Reduction** with zero added routing latency.

## What I deliberately did NOT build and why
- Redis / external queue: Kept Postgres as the single source of truth for architectural simplicity and zero extra infrastructure dependencies.
- Streaming (`stream:true`): Excluded to guarantee exact token and cost accounting at the end of each request.
- BYOK / Multi-tenancy: Gateway owns provider credentials via environment variables for clear boundaries.
- Complex frontend framework: Test console is built with a single plain HTML/JS file without any build tools.

## The test console (dev tool, not a deliverable)
A single static HTML file (`public/index.html`) served directly by Express at `GET /`. It was built strictly as a manual dev tool to exercise and demonstrate the gateway end-to-end:
- Zero build step, zero frontend frameworks, zero CDN dependencies.
- Secrets security: Virtual keys and admin secrets are typed into runtime password inputs and never stored in `localStorage`, cookies, or code.
- Exercises key generation, model routing (`auto` vs explicit), live chat completion latency/headers, and real-time usage/spend tracking. Explicitly documented as a developer verification tool rather than a scored UI.

## The decision I am least confident about
Heuristic keyword-based routing: Simple heuristics can be fooled by short but difficult queries or verbose simple queries. A lightweight embedding classifier or small routing model could yield better semantic routing, but adds latency and complexity.

## Where it breaks and what I'd do with one more week
A server process crash between the atomic reservation and the `finally` settlement block would leak a budget reservation until manually adjusted. With one more week, I would implement an asynchronous reservation ledger table with a background sweeper to reconcile stale in-flight reservations.
