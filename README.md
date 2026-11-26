# Minimal LLM Gateway

A high-performance, resilient, and cost-optimizing LLM API Gateway built with **plain JavaScript (ES modules, Node 20)**, **raw PostgreSQL (`pg`)**, and zero external ORM or framework bloat.

Designed with monetary budget protection, atomic reservation-then-refund accounting, deterministic zero-latency heuristic routing, circuit breaking, and clean provider resilience.

---

## 🚀 Live Deployed Service & Quick Test

The gateway is deployed live on Render with a pre-configured PostgreSQL instance. You can test it immediately using the live URL or the interactive web console:

- **Live Service URL:** [https://llm-gateway-set3.onrender.com](https://llm-gateway-set3.onrender.com)
- **Interactive Web Console:** [https://llm-gateway-set3.onrender.com](https://llm-gateway-set3.onrender.com)
- **Pre-provisioned Test Virtual API Key:** `gw_0b5979059ccd10d01d291354ad9dd3f2c24a39baf000431a`

> **Quick 1-Second cURL Test against Live Gateway:**
> ```bash
> curl -X POST https://llm-gateway-set3.onrender.com/v1/chat/completions \
>   -H "Authorization: Bearer gw_0b5979059ccd10d01d291354ad9dd3f2c24a39baf000431a" \
>   -H "Content-Type: application/json" \
>   -d '{
>     "model": "auto",
>     "messages": [
>       { "role": "user", "content": "What is the capital of India?" }
>     ]
>   }'
> ```

---

## Architecture & Request Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as LLM Gateway
    participant DB as PostgreSQL
    participant CB as Circuit Breaker
    participant Provider as Upstream LLM (Gemini)

    Client->>GW: POST /v1/chat/completions (Bearer gw_...)
    GW->>DB: Authenticate Key (SHA-256 hash lookup)
    DB-->>GW: Key Valid & Active

    GW->>CB: Check Provider State
    alt Circuit Breaker is OPEN
        GW-->>Client: 503 Service Unavailable
    end

    GW->>GW: Deterministic Router: Select Model (Cheap vs Capable)
    GW->>GW: Estimate Worst-Case Cost (chars/4 + Gateway Max Tokens)

    GW->>DB: Atomic Reservation (UPDATE ... WHERE spent + est <= budget)
    alt Insufficient Budget (No rows updated)
        GW-->>Client: 402 Payment Required (budget_exceeded)
    end
    DB-->>GW: Reservation Confirmed

    GW->>Provider: Forward Chat Request (Timeout + Bounded Retry)
    alt Cheap Tier Fails (5xx / 429)
        GW->>DB: Check & Top-Up Reservation for Capable Fallback
        GW->>Provider: Fallback Call to Capable Model
    end

    alt Upstream Fails Completely (502 / 504)
        GW->>CB: Record Failure (Trip if threshold exceeded)
        GW->>DB: Full Refund of Reservation + Log Failure
        GW-->>Client: 502 Bad Gateway / 504 Gateway Timeout (Sanitized)
    else Upstream Succeeds (200 OK)
        GW->>CB: Record Success
        Provider-->>GW: 200 OK (Content + Usage Metadata)
        GW->>DB: Atomic Reconcile: Settle Actual Cost & Refund Difference
        GW->>DB: Insert Usage Log (tokens_in, tokens_out, cost_paise, latency)
        GW-->>Client: 200 OK (Standard OpenAI Response + Gateway Headers)
    end
```

---

## Core Capabilities & Engineering Design

### 1. Atomic Reserve-Then-Refund Monetary Accounting
Instead of using floats or counting raw tokens, the gateway enforces budgets strictly in **integer paise** (₹1 = 100 paise; 1 paisa = ₹0.01). Float operations are strictly forbidden in budget math (`Math.ceil` guarantees integer units with zero precision drift).

1. **Before the Call (Worst-Case Reservation):**
   - Input tokens are estimated deterministically using `ceil(characters / 4)`.
   - Output tokens cannot be known ahead of time. Rather than letting clients exploit reservations, the gateway enforces a gateway-owned output token ceiling per model (e.g., 1000 for `gemini-3.5-flash-lite`, 2500 for `gemini-3.5-flash`).
   - Worst-case cost is calculated and deducted in a single atomic SQL statement:
     ```sql
     UPDATE api_keys
     SET spent_paise = spent_paise + $1
     WHERE id = $2 AND (spent_paise + $1) <= budget_paise
     RETURNING spent_paise, budget_paise;
     ```
   - If 0 rows are returned, the request is immediately rejected with HTTP `402 Payment Required` (`budget_exceeded`).

2. **After the Call (Atomic Settlement & Reconciliation):**
   - The provider returns actual token counts (`usage.prompt_tokens`, `usage.completion_tokens`).
   - Actual cost in paise is computed.
   - The unspent reserved difference is refunded atomically:
     ```sql
     UPDATE api_keys
     SET spent_paise = GREATEST(0, spent_paise - $1)
     WHERE id = $2;
     ```
   - On provider errors or timeouts (502/504), the reservation is **100% refunded**.
   - If upstream provider omits `usage` metadata, the gateway safely falls back to the gateway output token estimate rather than recording 0.

### 2. Circuit Breaker Pattern & Deadlock Protection
A robust in-memory state machine protects upstream providers and local resources:
- **`CLOSED`**: All traffic flows normally. Failures (5xx/504) increment consecutive failure counters.
- **`OPEN`**: When consecutive failures cross the threshold (default: 5), the circuit trips to `OPEN`. All incoming requests are immediately rejected with `503 Service Unavailable` (`Retry-After: 15`) without hitting the upstream provider.
- **`HALF_OPEN`**: After the cooldown period (15 seconds), the circuit transitions to `HALF_OPEN`. It allows **exactly one probe request** through to canary test provider recovery. If the probe succeeds, the circuit resets to `CLOSED`; if the probe fails (5xx/504), it resets the cooldown and re-enters `OPEN`.
- **Probe Release Protection**: If the probe request fails caller-side (400 validation error, 402 budget exceeded) before contacting the provider, `geminiBreaker.releaseProbe()` immediately unlocks the probe state so the next request can probe without delay. If a probe hangs or crashes, `isOpen()` expires `HALF_OPEN` after the cooldown duration to prevent indefinite lockouts.

### 3. Upstream Provider Resilience & Fallback
- **Per-Attempt Timeout:** Bounded by `PROVIDER_TIMEOUT_MS` (default: 30s) using native `AbortController`. Maps to `504 Gateway Timeout`.
- **Request Deadline:** Hard overall request deadline (`REQUEST_DEADLINE_MS`). If the deadline expires, pending retries are aborted.
- **Bounded Jittered Retry:** Exactly 1 retry with randomized jitter (50ms–150ms) for retryable errors (HTTP 5xx, 429, socket reset, timeouts). Caller format errors (400, 422) are **never** retried.
- **Cheap-to-Capable Fallback:** If the cheap tier (`gemini-3.5-flash-lite`) fails after its retry attempt, the gateway automatically falls back to the capable tier (`gemini-3.5-flash`). The gateway checks if the fallback model requires a higher reservation and atomically tops up the key's budget. If the user key lacks sufficient funds for the top-up, it fails safely with 402 `budget_exceeded`.
- **Sanitized Errors:** Upstream provider error bodies and upstream credentials are never leaked to callers. Upstream 401/403/404 errors are sanitized to `502 Bad Gateway`.

### 4. Deterministic Heuristic Router
Zero-latency routing table deciding between **Cheap Tier** (`gemini-3.5-flash-lite`) and **Capable Tier** (`gemini-3.5-flash`):
- Explicit model override requested (honored if allowlisted).
- Long input prompts (`> 1500 tokens`).
- Large output requests (`max_tokens > 1024`).
- Multi-turn conversation depth (`> 6 messages`).
- Code content or Markdown code blocks (`` `...` ``, ``` ``` ```).
- Reasoning keywords (`analyze`, `debug`, `prove`, `step by step`, `design`, `compare`).
- Otherwise routes to Cheap Tier (`short_simple_prompt`).

**Simulated Benchmark Results:** Running `node scripts/replay.js` across 30 varied prompts demonstrates:
- 15 prompts routed to Cheap (50%)
- 15 prompts routed to Capable (50%)
- Always-Capable Spend: 120 paise (₹1.20)
- Gateway Routed Spend: 75 paise (₹0.75)
- **Net Simulated Savings: 37.5% cost reduction** with zero LLM routing overhead.

### 5. Why Streaming is Rejected with 400
Streaming (`stream: true`) is deliberately rejected with HTTP `400 Bad Request`.
*Rationale:* In production LLM gateways, streaming token reconciliation requires:
1. Provider `stream_options: { include_usage: true }` support to receive the final usage chunk.
2. Tracking partial token streams across unexpected client disconnects mid-stream.
3. Keeping open connections and holding DB reservation locks across prolonged chunk intervals.
For take-home and low-overhead deterministic budget control, non-streaming ensures 100% reliable, zero-leak atomic accounting.

---

## Quickstart & Local Setup

### 1. Prerequisites
- Node.js 20+ installed
- PostgreSQL 14+ running locally (or via Docker)

### 2. Environment Configuration
Clone the repository and copy the environment template:
```bash
cp .env.example .env
```
Edit `.env` with your real settings:
```ini
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/llm_gateway2
ADMIN_SECRET=super_secret_admin_token_minimum_16_chars
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
MODEL_CHEAP=gemini-3.5-flash-lite
MODEL_CAPABLE=gemini-3.5-flash
```

### 3. Database Migration
Run the idempotent PostgreSQL migrations:
```bash
node src/db/migrate.js
```
*Output: `✓ Database migrations applied successfully.`*

### 4. Run the Server
```bash
npm start
```
The server will start at `http://localhost:3000`. You can also open `http://localhost:3000` directly in your browser to access the built-in **Developer Test Console**.

### 5. Run the Test Suite
Run the automated Vitest test suite:
```bash
npm test
```
> **Note**: The integration and concurrency tests require a local running PostgreSQL instance (as configured in `.env`). Ensure PostgreSQL is running and migrations have been applied (`npm run migrate`) before executing `npm test`.

### 6. Run Replay Benchmark
Simulated benchmark across 30 varied prompts:
```bash
npm run replay
```
*(Optional) You can also run the replay through the live gateway and record actual metrics from PostgreSQL `usage_logs`:*
```bash
node scripts/replay.js --live
```

---

## Working cURL Commands

> The commands below target the live deployed service (`https://llm-gateway-set3.onrender.com`). If running locally, replace with `http://localhost:3000`.

### 1. Health Check
```bash
curl -X GET https://llm-gateway-set3.onrender.com/health
```
**Response (200 OK):**
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-11-26T21:30:00.000Z"
}
```

### 2. Create Virtual API Key (Admin)
Creates a virtual key with ₹50 budget (5,000 paise):
```bash
curl -X POST https://llm-gateway-set3.onrender.com/admin/keys \
  -H "Authorization: Bearer <ADMIN_SECRET_PROVIDED_IN_EMAIL>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "evaluator-key",
    "budget_paise": 5000
  }'
```
**Response (201 Created):**
```json
{
  "id": "19b4e13e-a745-4221-8255-a4bcbf340c21",
  "name": "evaluator-key",
  "key": "gw_0b5979059ccd10d01d291354ad9dd3f2c24a39baf000431a",
  "key_prefix": "gw_0b597",
  "budget_paise": 5000,
  "spent_paise": 0,
  "created_at": "2026-11-26T21:30:00.000Z"
}
```
*(Store the full `gw_...` key safely; only the SHA-256 hash is saved in the database!)*

### 3. Send Chat Completion (Proxy)
Sends a chat completion request through the gateway using the pre-provisioned evaluator virtual key:
```bash
curl -X POST https://llm-gateway-set3.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer gw_0b5979059ccd10d01d291354ad9dd3f2c24a39baf000431a" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "What is the capital of India?" }
    ]
  }'
```
**Response Headers:**
```http
x-gateway-request-id: req_404b9c9f0003b...
x-gateway-model: gemini-3.5-flash-lite
x-gateway-route-reason: short_simple_prompt
x-gateway-cost-paise: 1
```
**Response Body (200 OK):**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1764137100,
  "model": "gemini-3.5-flash-lite",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of India is New Delhi."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 8,
    "total_tokens": 23
  }
}
```

### 4. Query Spend and Usage Logs (Admin)
Query aggregate spend metrics and request log history (optionally filter by `key_id`):
```bash
curl -X GET "https://llm-gateway-set3.onrender.com/usage" \
  -H "Authorization: Bearer <ADMIN_SECRET_PROVIDED_IN_EMAIL>"
```
**Response (200 OK):**
```json
{
  "key": null,
  "summary": {
    "total_requests": 1,
    "total_spent_paise": 1,
    "total_spent_inr": "0.01",
    "total_tokens_in": 15,
    "total_tokens_out": 8
  },
  "models": [
    {
      "model": "gemini-3.5-flash-lite",
      "requests": 1,
      "cost_paise": 1,
      "cost_inr": "0.01",
      "tokens_in": 15,
      "tokens_out": 8
    }
  ],
  "statuses": {
    "ok": 1
  },
  "recent_logs": [
    {
      "id": "7f139260-ca27-466a-bc3e-bf64b3c41efb",
      "request_id": "req_404b9c9f0003b...",
      "api_key_id": "19b4e13e-a745-4221-8255-a4bcbf340c21",
      "provider": "gemini",
      "model": "gemini-3.5-flash-lite",
      "route_reason": "short_simple_prompt",
      "tokens_in": 15,
      "tokens_out": 8,
      "cost_paise": 1,
      "cost_inr": "0.01",
      "status": "ok",
      "latency_ms": 532,
      "error_code": null,
      "created_at": "2026-11-26T11:25:01.000Z"
    }
  ]
}
```

---

## Docker Deployment

### Build Docker Image
```bash
docker build -t minimal-llm-gateway .
```

### Run Container
```bash
docker run -d \
  --name llm-gateway \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/llm_gateway2" \
  -e ADMIN_SECRET="super_secret_admin_token_minimum_16_chars" \
  -e GEMINI_API_KEY="your_gemini_api_key" \
  minimal-llm-gateway
```
The container automatically runs idempotent PostgreSQL migrations upon boot before binding to port 3000.

---

## Repository Structure

```
├── .env.example              # Environment variables template
├── .dockerignore             # Docker build ignores
├── Dockerfile                # Production-ready Node 20 Alpine container
├── package.json              # ES module manifest (zero ORMs)
├── ARCHITECTURE.md           # Architectural blueprint
├── CONTEXT.md                # Engineering constraints & context
├── DECISIONS.md              # Living architectural decisions and rationale
├── AI-LOG.md                 # AI usage, overrides, and engineering audit
├── README.md                 # Complete documentation & cURL guides
├── public/
│   └── index.html            # Single-file vanilla JS developer test console
├── scripts/
│   └── replay.js             # Table-driven heuristic router benchmark replay
├── src/
│   ├── admin/                # Admin endpoints (key creation, usage inspection)
│   ├── auth/                 # Constant-time auth & SHA-256 virtual key verification
│   ├── budget/               # Token estimation, pricing, atomic reserve & settle
│   ├── config/               # Zod env parsing & official model pricing catalogs
│   ├── db/                   # Raw pg Pool & idempotent SQL migrations
│   ├── gateway/              # Chat proxy handler, circuit breaker, resilience
│   ├── providers/            # OpenAI-compatible HTTP fetch client & credentials
│   ├── router/               # Pure heuristic router (table-driven)
│   └── server.js             # Express app bootstrap & route registration
└── tests/                    # 43 automated unit & integration tests (Vitest)
```

---

## Security & Reliability Highlights
- **Zero Secrets in Git or Logs:** Virtual keys are hashed with SHA-256. Raw keys are displayed only once upon creation.
- **Timing Safe:** Admin secrets are validated using `crypto.timingSafeEqual`.
- **Zero Float Inaccuracies:** Integer paise used end-to-end.
- **No Resource Leaks:** Every reservation is refunded on failure, timeout, or cancellation.
- **No Upstream Leaks:** Sanitized error handling shields internal provider traces and credentials.
