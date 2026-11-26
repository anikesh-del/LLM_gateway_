# ARCHITECTURE.md: Minimal LLM Gateway

## 1. What this is
A small HTTP service between callers and an LLM provider. It adds: virtual API keys, per-key monetary budgets enforced atomically, usage/spend logging in PostgreSQL, timeout + bounded retry + clear failure, and a cheap-vs-capable router (stretch). Deployed to one public URL.

Model: **gateway-owned provider keys** (env vars on the server). BYOK / multi-tenant is deliberately NOT built; credentials are read through one function, `getProviderCredentials(provider)`, so BYOK can be added later.

## 2. Scope (locked)
| Component | Decision |
|---|---|
| Provider | One real provider: **Gemini (default)**, called via its OpenAI-compatible endpoint |
| Provider credentials | Server-side env var only |
| Client auth | Gateway-issued virtual keys (`Authorization: Bearer gw_...`) |
| Budget | Per-key monetary budget, integer **paise** |
| Usage tracking | PostgreSQL |
| Budget correctness | Single atomic `UPDATE ... WHERE` reservation, then settlement |
| Provider communication | Non-streaming (`stream:true` -> 400) |
| Resilience | Timeout, bounded retry where safe, clear failure |
| Deployment | One public API URL |
| Stretch | Cheap-vs-capable router |

Groq/OpenRouter are optional extras behind the same provider interface (OpenAI-compatible, only the base URL and key differ). They are **disabled by default**. Do not build them until the core is done and tested.

## 3. Stack
Node 20, **plain JavaScript (ES modules, no TypeScript)**, Express, `pg` (raw SQL, no ORM, so budget SQL is visible), `zod` (runtime validation), `pino`, `vitest` + `supertest`, Docker. Add short JSDoc comments on non-obvious functions. Host: Render/Railway/Fly.io with Neon or Supabase Postgres.

## 4. Request lifecycle
```
Client
  | POST /v1/chat/completions  (Bearer gw_...)
  v
[1] Validate body (zod), reject stream:true, enforce body-size limit
[2] Auth: sha256(key) -> api_keys row; reject missing/unknown/revoked -> 401
[3] Router: pick model + reason (explicit model honored; "auto"/omitted -> rules)
[4] Estimate worst-case cost (input tokens est + max_tokens * output price)
[5] Reserve budget (atomic UPDATE). 0 rows -> 402 budget_exceeded
[6] Provider call with timeout; retry/fallback per policy (section 7)
[7] Settle in finally{}: actual cost from provider usage (fallback: estimate);
    spent = spent - reserved + actual; INSERT usage_logs (same transaction)
    On total failure: refund reservation, log failed row
[8] Return OpenAI-shaped response (+ x-gateway-request-id, x-gateway-model, x-gateway-route-reason headers)
```

## 5. Data model
```sql
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  key_prefix    text NOT NULL,             -- first 8 chars, for display only
  key_hash      text NOT NULL UNIQUE,      -- sha256 hex of full key
  budget_paise  bigint NOT NULL CHECK (budget_paise >= 0),
  spent_paise   bigint NOT NULL DEFAULT 0 CHECK (spent_paise >= 0), -- settled + in-flight reservations
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    text NOT NULL,
  api_key_id    uuid NOT NULL REFERENCES api_keys(id),
  provider      text NOT NULL,
  model         text NOT NULL,             -- model that actually served the request
  route_reason  text NOT NULL,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  cost_paise    bigint  NOT NULL DEFAULT 0,
  status        text NOT NULL,             -- ok | provider_error | timeout | budget_rejected
  attempts      smallint NOT NULL DEFAULT 1,
  latency_ms    integer,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_logs (api_key_id, created_at DESC);
```
Money is **integer paise**, never floats. Migrations are plain `.sql` files run by a tiny script.

## 6. Budget enforcement (the critical part)
Reserve (atomic, no read-then-write):
```sql
UPDATE api_keys
SET spent_paise = spent_paise + $reserve
WHERE id = $1 AND revoked_at IS NULL AND spent_paise + $reserve <= budget_paise
RETURNING spent_paise, budget_paise;
```
Zero rows -> 402. Row-level locking in Postgres makes two concurrent requests on a near-exhausted key serialize; only one can win.

Settle: `UPDATE api_keys SET spent_paise = GREATEST(spent_paise - $reserve + $actual, 0) WHERE id=$1` plus the `usage_logs` insert in one transaction. Failed call: `actual = 0` (refund). Settlement lives in `finally` so client disconnects don't leak reservations.

Cost estimate: `ceil((tokens * price_usd_per_million / 1e6) * USD_INR_RATE * 100)` paise. Input tokens estimated as `ceil(chars/4)` before the call; actual from the provider `usage` field after (fallback to estimate if missing). `max_tokens` is **required or defaulted and capped** (`MAX_OUTPUT_TOKENS`), so worst-case cost is bounded.

If a fallback attempt uses a model with a higher worst-case cost, top up the reservation atomically (same UPDATE pattern with the delta) before calling it; failure -> 402.

Known limit (document honestly): a crash between reserve and settle leaks a reservation. Fix would be a reconciliation job (reservation table + sweeper). Not built.

## 7. Resilience policy
- Per-attempt timeout `PROVIDER_TIMEOUT_MS` (default 20s); overall deadline `REQUEST_DEADLINE_MS` (default 45s).
- Retry **only** on timeout, network error, HTTP 5xx, HTTP 429; max 1 retry with small jittered backoff.
- **Never** retry caller-caused 4xx (400/401/403/404); map to a clean 400/502 without leaking the provider body.
- After retries: cheap tier falls back to the capable model (accept higher cost for reliability, logged with its real price); capable tier has no further fallback.
- All failed: **502** (provider error) or **504** (timeout) with a generic JSON error; reservation refunded; failed row logged.
- Provider raw error bodies are logged server-side only, never returned.

## 8. Router (stretch)
Pure function: `route(req, config) -> { model, tier, reason }`. No LLM in the routing path.
- Explicit `model` in the allowlist -> honored, reason `explicit`.
- `model` omitted or `"auto"` -> rules:
  - **Capable** if any: estimated input tokens > `ROUTER_LONG_PROMPT_TOKENS` (default 1500); contains a code fence or code-like content; reasoning keywords (`step by step`, `analyze`, `prove`, `debug`, `design`, `compare`); `max_tokens` > `ROUTER_CAPABLE_MAX_TOKENS` (default 1024); more than 6 messages.
  - **Cheap** otherwise, reason `short_simple_prompt`.
- Reserve using the routed model's price.
- Config: `MODEL_CHEAP`, `MODEL_CAPABLE` (default Gemini Flash-Lite/Flash-class and Pro-class). **Verify current model IDs and prices from Gemini docs before hardcoding;** keep them in `src/config/pricing.js`, labelled estimates.
- Measure: `scripts/replay.js` replays ~30 varied prompts, reports total cost with routing vs always-capable and the tier split. Put the real number in DECISIONS.md.
- Weakness to state: short prompts can be hard; heuristics misroute. Next step would be a quality signal/feedback loop.

## 9. HTTP API
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/chat/completions` | virtual key | OpenAI-compatible, non-streaming |
| POST | `/admin/keys` | admin secret | create key `{name, budget_paise}`; key returned **once** |
| POST | `/admin/keys/:id/revoke` | admin secret | revoke |
| GET | `/usage?key_id=...` | admin secret | total spend, remaining budget, request count, per-model breakdown |
| GET | `/health` | none | liveness (+ DB ping) |
| GET | `/` | none | static test console (`public/index.html`), see section 14 |

Admin secret compared in constant time (`crypto.timingSafeEqual`). Error shape: `{ "error": { "code": "...", "message": "..." } }`.
Error codes: `invalid_request` 400, `unauthorized` 401, `budget_exceeded` 402, `provider_error` 502, `provider_timeout` 504.

## 10. Config (env only; commit `.env.example` with placeholders)
`DATABASE_URL`, `GEMINI_API_KEY`, `ADMIN_SECRET`, `DEFAULT_PROVIDER=gemini`, `GEMINI_BASE_URL`, `MODEL_CHEAP`, `MODEL_CAPABLE`, `USD_INR_RATE`, `PROVIDER_TIMEOUT_MS`, `REQUEST_DEADLINE_MS`, `MAX_OUTPUT_TOKENS`, `ROUTER_*`, optional `GROQ_API_KEY`, `OPENROUTER_API_KEY` (unused unless enabled). Validate with zod at boot; fail fast if required vars are missing. `.env` is in `.gitignore` from the first commit.

## 11. Layout
```
src/
  server.js            app wiring, graceful shutdown
  config/{env.js,pricing.js}
  db/{pool.js,migrate.js}  migrations/001_init.sql
  auth/{virtualKey.js,adminAuth.js}
  budget/{estimate.js,reserve.js,settle.js}
  providers/{types.js,openaiCompatible.js,credentials.js}  # credentials.js = getProviderCredentials()
  router/route.js
  gateway/{chatHandler.js,resilience.js}
  admin/{keys.js,usage.js}
scripts/replay.js
public/index.html       # single-file test console (see section 14)
tests/
DECISIONS.md  AI-LOG.md  README.md  Dockerfile  .env.example
```

## 12. Tests (must exist)
1. **Concurrency:** key with budget for exactly 1 request; fire N parallel requests; exactly one succeeds, rest 402, `spent <= budget`.
2. **Fallback:** mocked provider returns 500 / times out / 429 -> retry then fallback; 400 -> no retry; all fail -> 502/504 and reservation refunded.
3. **Router:** table-driven cases for each rule.
4. **Auth:** missing/unknown/revoked key -> 401; key never stored in plaintext.
5. Settlement: missing `usage` in provider response uses estimate.
Use a mock provider server; never hit the real provider in tests.

## 13. Deliberately not built
A polished UI (only the single-file test console in section 14), streaming, caching, Redis/rate limiting (a per-key in-memory token bucket is an optional extra, single-instance only), BYOK/multi-tenancy, UI, reconciliation job, async logging queue. Each must be listed in DECISIONS.md with the reason.

## 14. Test console (dev tool, not a deliverable)
One static file, `public/index.html`: plain HTML + vanilla JS, no framework, no build step, no CDN dependencies, served by Express. It exists only so the author can exercise the API by hand. Max ~200 lines, zero styling effort.
- Inputs: admin secret and virtual key (typed into password fields at runtime; **never stored in code, localStorage or logs**).
- Panels: create key (name, budget) -> shows the key once; send chat (model dropdown incl. `auto`, prompt, max_tokens) -> shows response, and the `x-gateway-model` / route-reason / cost; usage view for a key (spend, remaining, recent rows); revoke key.
- It calls the same public endpoints as curl. No special backend routes for it.
- Mention it in DECISIONS.md as a testing aid, explicitly not a scored feature.
