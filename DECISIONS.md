# DECISIONS.md: Design and Architecture Decisions

## What I built
A minimal, production-grade LLM Gateway in plain JavaScript (ES modules, Node 20, Express, raw `pg`) between client callers and provider models (Gemini default via OpenAI-compatible endpoint). It features gateway-issued virtual API keys, atomic budget reservations in integer paise against PostgreSQL, automatic cost extraction and usage logging, bounded retries/fallbacks, a circuit breaker for upstream outages, and a deterministic cheap-vs-capable heuristic router.

## Moving parts and request lifecycle
```
Client (Authorization: Bearer gw_...)
  |
  v
[1] Circuit breaker check: fail-fast 503 if OPEN (with Retry-After header)
[2] Body validation (zod), stream:true rejection, size limits
[3] Virtual key auth: sha256(key) lookup in api_keys table
[4] Model routing: explicit allowlist check or heuristic rules -> model + reason
[5] Cost estimation: est input tokens (chars/4) + gateway default output ceiling * model price
[6] Atomic budget reservation: UPDATE api_keys ... WHERE spent_paise + reserve <= budget_paise
[7] Provider execution with per-attempt timeout, bounded jittered retry, and cheap->capable fallback
[8] finally{} settlement: actual cost calculated (with fallback estimate if usage missing);
    transactionally updates spent_paise and logs to usage_logs. Retry settlement once if DB fails.
[9] Return OpenAI-shaped response (+ x-gateway-request-id, x-gateway-model, x-gateway-route-reason)
```

## Top 3-5 decisions (Options considered, pick, tradeoff knowingly accepted)

### 1. Plain JavaScript (ES modules) over TypeScript
- **Options considered**: (A) TypeScript with `tsc`/`ts-node` or `tsx`, (B) Plain JavaScript with ES modules and Zod.
- **Pick**: Plain JavaScript (ES modules) + Zod runtime schemas + JSDoc.
- **Tradeoff knowingly accepted**: We forego compile-time type checking in exchange for zero build step, simpler debugging, faster cold starts, and 100% explainability for an author comfortable in JS.

### 2. Integer Paise and Raw SQL over ORM / Floats
- **Options considered**: (A) Floats with Prisma/TypeORM, (B) Decimal types in DB with ORM, (C) Integer paise with raw `pg` client.
- **Pick**: Integer paise using raw parameterized SQL queries.
- **Tradeoff knowingly accepted**: Writing manual SQL queries and migrations instead of automatic schema generation, in exchange for guaranteeing zero floating-point rounding errors and exposing the exact concurrency-safe `UPDATE ... WHERE ... RETURNING` locking mechanics.

### 3. Gateway-Controlled Output Reservations vs Client `max_tokens`
- **Options considered**: (A) Trust client's `max_tokens` for reservation and upstream execution, (B) Gateway sets fixed output ceilings per model while using `body.max_tokens` only as an advisory routing signal.
- **Pick**: Dual-purpose design:
  1. The heuristic router reads `body.max_tokens` strictly as an advisory signal of caller intent: if the caller requests `max_tokens > 1024`, the prompt routes to the capable model.
  2. For budget reservation and provider invocation, the gateway overrides `max_tokens` with fixed gateway-owned ceilings (`gemini-3.5-flash-lite`: 1000 tokens, `gemini-3.5-flash`: 2500 tokens).
- **Tradeoff knowingly accepted**: A caller who intends a brief answer from capable still has budget reserved for 2500 tokens until the call settles. The critical benefit is preventing adversarial or broken clients from passing `max_tokens: 100000` to lock up massive budgets or passing `max_tokens: 1` to slip past budget enforcement and generate runaway costs.

### 4. Circuit Breaker for Upstream Resilience & Deadlock Prevention
- **Options considered**: (A) Indefinite retries and timeouts on every request, (B) Lightweight tri-state in-memory Circuit Breaker (`CLOSED`, `OPEN`, `HALF_OPEN`) with explicit probe release.
- **Pick**: In-memory Circuit Breaker tripping after 5 consecutive transient failures with probe lifecycle management.
- **Deadlock prevention in `HALF_OPEN`**: When the breaker enters `HALF_OPEN`, it grants a single probe request. If that request is rejected caller-side (e.g., 400 schema validation, 400 stream rejection, or 402 budget exhaustion) before reaching the provider, `geminiBreaker.releaseProbe()` immediately resets the breaker to `OPEN` with expired cooldown so the next legitimate request can probe. Additionally, `isOpen()` expires `HALF_OPEN` after the cooldown duration if a probe is abandoned, preventing permanent 503 lockouts.
- **Tradeoff knowingly accepted**: Multi-instance deployments would not share breaker state without Redis, but each node independently fails fast in 0ms and saves client latency and socket exhaustion during upstream outages.

### 5. Masking Raw Provider Errors
- **Options considered**: (A) Forward provider error JSON directly to client, (B) Map to sanitized gateway error envelope.
- **Pick**: Sanitize all upstream errors. Provider 400/422 map to 400; provider 401/403/404/5xx map to 502/504.
- **Tradeoff knowingly accepted**: Clients cannot see internal provider stack traces or Google AI Studio specific links, but internal keys and provider configurations are never leaked.

## Why enforce budgets at the gateway (First principles)
Provider APIs do not offer fine-grained real-time balance limits per virtual sub-key. Enforcing budgets at the gateway before the provider API call occurs prevents runaway expenses, runaway loops, and accidental overspending across multiple client applications sharing a single upstream provider account.

### Why paise over requests or tokens?
- **Paise over request count**: Request counts treat a 50-token query identically to a 4,000-token query, making it impossible to control actual monetary spend.
- **Paise over raw token count**: Different models cost vastly different amounts per token (e.g. Gemini Pro is 10x more expensive than Flash-Lite). Tracking raw tokens would give users a false sense of quota while bankrupting the account on capable models. Integer paise unifies all models into actual currency.

### Why the Reserve-then-Refund pattern?
1. **Input tokens are knowable upfront**: Approximated with $\lceil \text{chars}/4 \rceil$.
2. **Output tokens are inherently unknowable before generation**: The gateway estimates the output ceiling per model and reserves worst-case cost.
3. **Known limitation (Underestimation risk)**: Because $\lceil \text{chars}/4 \rceil$ is an approximation, dense code or non-English scripts can sometimes consume more tokens than estimated. In rare cases where actual tokens exceed the estimate, `settleBudget` still records the true cost, which can cause `spent_paise` to slightly exceed `budget_paise` after reconciliation.
4. **Atomic reservation via SQL**:
   ```sql
   UPDATE api_keys
   SET spent_paise = spent_paise + $estimate
   WHERE id = $1 AND revoked_at IS NULL AND spent_paise + $estimate <= budget_paise
   RETURNING spent_paise;
   ```
   Zero rows returned indicates immediate budget exhaustion (402).
5. **Post-call reconciliation (settlement)**:
   ```sql
   UPDATE api_keys SET spent_paise = GREATEST(spent_paise - $estimate + $actual, 0) WHERE id = $1;
   ```
   If usage is missing from provider, gateway falls back to estimated output tokens rather than 0. If provider fails/times out, `actual = 0` (100% full refund).

## Concurrency behaviour
Two concurrent requests on a near-exhausted key serialize on the PostgreSQL row lock of the `UPDATE api_keys` statement. The first request increments `spent_paise` within the limit and proceeds; the second request evaluates `spent_paise + $reserve <= budget_paise` which evaluates to false, updating 0 rows, and fails immediately with HTTP 402 `budget_exceeded`.

Proved by automated test in `tests/budget.test.js`:
- An API key is created with budget sufficient for exactly 1 request (`singleReqWorstCase` in paise).
- 5 parallel HTTP requests are fired simultaneously against `/v1/chat/completions`.
- Result: Exactly 1 request completes with 200 OK; the remaining 4 requests are rejected with 402 `budget_exceeded`.
- The database balance verification confirms `spent_paise <= budget_paise` holds true.

## Fallback policy and why
Retry once on transient network errors, timeouts, or provider 5xx/429 with jittered backoff.
- **Never retry caller 4xx**: Errors such as 400 or 422 are deterministic caller format errors. Retrying them wastes budget and introduces useless latency.
- **Circuit Breaker Pattern (`CLOSED` -> `OPEN` -> `HALF_OPEN`)**:
  - If 5 consecutive transient failures (5xx or timeouts) occur, the circuit breaker trips **`OPEN`**.
  - Subsequent incoming requests fail fast in **0ms** with `503 circuit_open` and a `Retry-After: 15` header.
  - After a 15-second cooldown, it transitions to **`HALF_OPEN`** and blocks all other concurrent requests while allowing **one single probe request** to test provider recovery. If the probe succeeds, the breaker resets to `CLOSED`. If it fails, it trips back to `OPEN`.
  - **Probe Deadlock Protection**: If a probe request fails caller-side (e.g. 400 validation, 402 budget exceeded), `geminiBreaker.releaseProbe()` immediately unlocks the probe state so the next request can probe without waiting for cooldown. Additionally, `isOpen()` expires `HALF_OPEN` after the cooldown duration to prevent indefinite lockouts.
- **Cheap-to-capable fallback**: If a cheap-tier model (`gemini-3.5-flash-lite`) fails after retry, the gateway tops up the budget reservation and falls back to the capable model (`gemini-3.5-flash`) to protect caller availability.
- **Same-provider-only limitation**: In this take-home, fallback is configured between model tiers on Gemini rather than across multiple providers. Tradeoff: If Google has a global region outage, switching to a secondary provider (like Groq) would be superior; however, multi-provider credentials introduce distinct rate structures, schema idiosyncrasies, and security surfaces.
- **Budget top-up guarantee**: If the virtual key lacks sufficient remaining balance to afford the capable model's reservation, the fallback does not execute, avoiding overdrafts, and returns HTTP 402 `budget_exceeded`.

## Router policy, why it is shaped that way, and the simulated result
Deterministic heuristic router with zero LLM overhead:
1. **Explicit override & allowlist**: If the client passes a specific model name, it must be in the allowlist (`gemini-3.5-flash-lite`, `gemini-3.5-flash`) or it is rejected with 400 `invalid_model`.
2. **Deterministic heuristics**: When `model` is omitted or `"auto"`, the request is routed to **Capable** (`gemini-3.5-flash`) if any of these trigger:
   - Estimated input tokens > 1500 (`ROUTER_LONG_PROMPT_TOKENS`).
   - Requested `max_tokens` > 1024 (`ROUTER_CAPABLE_MAX_TOKENS`) as caller generation intent.
   - Multi-turn conversation depth > 6 messages.
   - Code detected (markdown fences ```` ``` ````, keywords `function`, `class`, `import`).
   - Reasoning keywords (`step by step`, `analyze`, `prove`, `debug`, `design`, `compare`).
3. Otherwise, it defaults to **Cheap** (`gemini-3.5-flash-lite`) with reason `short_simple_prompt`.

### Replay Benchmark (`scripts/replay.js`):
Evaluated a representative workload of 30 diverse queries (short Q&A, coding, analysis, and system design):
- **Total Prompts**: 30
- **Routed to Cheap Tier**: 15 (50.0%)
- **Routed to Capable Tier**: 15 (50.0%)
- **Always-Capable Baseline Spend**: 120 paise (₹1.20)
- **Gateway Routed Spend**: 75 paise (₹0.75)
- **Net Simulated Savings**: **45 paise (₹0.45) -> 37.5% Cost Reduction**.
- *Caveats & Honesty*:
  - The default replay is **simulated** using an assumed average of 150 output tokens.
  - **Response quality was NOT evaluated** across tiers.
  - A live execution mode (`node scripts/replay.js --live`) is provided to execute all prompts through the live gateway and measure actual PostgreSQL `usage_logs` costs.

## Synchronous vs Asynchronous Logging
- **Decision**: Synchronous logging directly in the database transaction of `settleBudget` inside `finally`.
- **Options considered**: (A) Async background worker (BullMQ/Redis), (B) In-memory buffered batch flush, (C) Synchronous DB insert in same transaction as balance settlement.
- **Tradeoff knowingly accepted**: Adding ~5-10ms of database I/O to the tail of the request. In exchange, audit logs and monetary balance adjustments are strictly consistent in the same PostgreSQL transaction (`COMMIT`), eliminating lost logs or unbilled usage on sudden process crash.

## What I deliberately did NOT build and why
1. **Semantic / Vector Routing**: Calling an embedding model or LLM to route adds 150-300ms of latency and non-trivial cost to every prompt. Heuristics run in <0.1ms.
2. **Semantic Caching**: LLM responses vary; exact or semantic prompt caching requires Redis vector indexes and invalidation complexity with low hit rates on dynamic user queries.
3. **Streaming (`stream: true`)**: Streaming hides token usage until the final chunk. If a client disconnects mid-stream, accounting requires tokenizing forwarded chunks on the fly. Non-streaming guarantees exact token reconciliation.
4. **Multi-tenancy / BYOK**: Gateway owns provider credentials via environment variables for clear operational boundaries.
5. **Reconciliation Job / Stale Reservation Sweeper**: A process crash between atomic reserve and `finally` settlement leaks a reservation. A sweeper table would fix this; omitted for take-home scope.
6. **Rate Limiting on 402 Rejections**: To prevent table bloat and high write amplification during brute-force or runaway loops on empty keys, the gateway does not insert `usage_logs` rows on 402 rejections.

## The decision I am least confident about (Both sides)
**Gateway-owned Output Ceiling vs Client-specified `max_tokens`**:
- *Argument for Gateway control*: Prevents callers from manipulating reservation amounts or holding massive reservations that block their own concurrent requests.
- *Argument for Client control*: If a client only expects a 2-sentence response from a capable model, reserving 2,500 tokens locks up unnecessary budget until the call finishes.

## Where it breaks and what I'd do with one more week
1. A hard container kill (`SIGKILL`) between `reserveBudget` and `settleBudget` leaks a reservation. With one more week, I would implement a reservations ledger table and a background sweeper.
2. Add cross-provider fallback to Groq or OpenRouter for multi-cloud resilience during global Google outages.
