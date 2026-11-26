# AI-LOG.md: AI Usage and Engineering Log

## Which AI tools/models were used and for what
- Used Google Antigravity (Gemini 3.8 Flash) for scaffolding repository foundation, verifying official provider pricing, designing schema, and drafting initial migrations.
- Used Gemini 3.8 Flash for implementing Phase 2: constant-time admin authentication, `crypto.randomBytes` virtual key generator, and SHA-256 virtual key verification middleware.
- Used Gemini 3.8 Flash for implementing Phase 3: token estimation heuristic (`ceil(chars / 4)`), cost calculation in integer paise directly using Indian Rupees (INR) rates, OpenAI-compatible proxy client, `usage_logs` writer, and tracking headers.
- Used Gemini 3.8 Flash for implementing Phase 4: atomic budget reservation (`reserveBudget`), transactional settlement & refund (`settleBudget`), and 5-way parallel concurrency testing.
- Used Gemini 3.8 Flash for implementing Phase 5: resilience policy in `executeWithResilience` (overall deadline, bounded retry, jittered backoff, cheap-to-capable fallback, incremental reservation top-up, and mock resilience test suite).
- Used Gemini 3.8 Flash for implementing Phase 6: pure heuristic router `route()`, table-driven tests for every routing rule, budget reservation by routed model, and `scripts/replay.js` benchmark recording a verified 34.5% cost reduction.
- Used Gemini 3.8 Flash for implementing Phase 7: admin usage reporting handler (`GET /usage`) with spend/token/model breakdown, and single-file vanilla JS developer test console (`public/index.html`).

## One place the AI was wrong or misleading and how it was caught
- The AI initially configured `MODEL_CHEAP=gemini-2.5-flash` and `MODEL_CAPABLE=gemini-2.5-pro` based on older Gemini documentation. When tested against Google's live OpenAI-compatible endpoint, Google returned HTTP 404 with message: *"This model models/gemini-2.5-flash is no longer available to new users."* Caught by live manual testing in the test console and querying the live models endpoint. Updated to currently active models: `gemini-3.5-flash-lite` (Cheap) and `gemini-3.5-flash` (Capable).

## One place the author overrode the AI and why
- Clarified using plain JavaScript ES modules rather than TypeScript (noting the author's preference and context rules), and standardized file naming to uppercase `DECISIONS.md` and `AI-LOG.md`.

## How control was kept over code not typed by hand (secrets, budget logic, provider call)
- Secrets: Strict `.gitignore` protecting `.env`, `.env.example` using dummy placeholders only, and zero hardcoded credentials.
- Budget logic: Implemented using raw SQL single-statement atomic `UPDATE` with integer paise to avoid float errors and JavaScript-side race conditions.
- Provider verification: Gemini OpenAI-compatible endpoint URL and pricing verified directly against Google AI Studio documentation rather than memory.

## Something learned from scratch and how
- `TODO (author)`
