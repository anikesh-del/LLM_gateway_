# CONTEXT.md: Project Context and Working Rules

## Why this exists
This is a backend-internship take-home: "Build a Minimal LLM Gateway", deployed to a real URL, about 10-14 focused hours. It is graded on backend correctness, system design, first-principles reasoning, production-readiness, and how well the author directs AI **while staying in control**. UI is not scored. A small service that fully works and is well-explained beats a big one that half-works. Cutting scope is expected, as long as it is named and justified.

The author is a backend learner (Node/Express, comfortable in JavaScript, **not in TypeScript, so use plain JavaScript with ES modules and keep code simple and well-commented**; Node/Express, PostgreSQL, Redis, BullMQ, Docker, Spring Boot) who must be able to **explain and defend every line** on a follow-up call. Optimize for clarity and explainability over cleverness.

## Hard requirements (from the brief)
1. Proxy a chat-completion call to a real provider (non-streaming; reason: exact token/cost accounting, simpler failure handling).
2. Virtual API keys; real provider credentials server-side only, never in the repo or any response.
3. Per-key budget that actually blocks (402/429) when exceeded.
4. Persist per-request usage (key, model, tokens in/out, estimated cost, timestamp); answer "how much has key X spent?"
5. Fallback/resilience with a defended policy.
6. Deploy to a public URL with secrets handled properly.
Stretch (exactly one): cheap-vs-capable router, with a justified policy and a measured result.

Deliverables: deployed URL + working curl, source repo, `DECISIONS.md` (most important), `AI-LOG.md`, optional <=5 min screen recording.

## Source of truth
`ARCHITECTURE.md` defines the design, schema, lifecycle, budget SQL, resilience policy, router, API, env vars and tests. Follow it. If you think it is wrong, **stop and say so with reasoning** instead of silently deviating; record any agreed deviation in DECISIONS.md.

## Non-negotiable rules
**Secrets**
- Never write a real API key, DB password or admin secret into any file, commit, log, test, fixture, prompt or doc. Use placeholders in `.env.example`; real values live only in a git-ignored `.env` and the host's env settings.
- `.gitignore` (with `.env`) is created before the first commit. Never log request auth headers or provider keys. Never return provider keys or raw provider error bodies to clients.
- Virtual keys: generate with `crypto.randomBytes`, show once, store only sha256 hash + 8-char prefix.

**Budget and money**
- Integer paise only. No floats stored. No read-then-write budget checks; use the single atomic `UPDATE ... WHERE` from ARCHITECTURE.md section 6.
- Settlement happens in `finally`. Every failure path refunds the reservation.
- Any change to budget, auth, or provider-call code must come with a test.

**Scope discipline**
- Do not add Redis, Kafka, queues, ORMs, TypeScript, frontend frameworks, streaming, caching, multi-tenancy or extra providers unless the author explicitly asks. If you feel tempted, add it under "What I would do with one more week" in DECISIONS.md instead.
- Build in the phases below, and **stop at the end of each phase** for the author to review, run and understand the diff.
- No dead code, no unexplained abstractions. If a piece cannot be justified in one sentence, remove it.

**Provider facts**
- Gemini is the default provider via its OpenAI-compatible endpoint. **Verify current model IDs, endpoint path and pricing against official docs** (do not trust memory); put them in `src/config/pricing.js` as estimates with a source comment and a date.

## Phases
1. **Foundation:** repo, TypeScript, `.gitignore`, `.env.example`, env validation, Postgres pool, migration `001_init.sql`, `/health`.
2. **Keys and auth:** admin create/revoke key, virtual-key auth middleware, admin-secret auth (constant-time).
3. **Proxy:** `/v1/chat/completions` with zod validation, provider client, usage extraction, `usage_logs` write, cost estimation.
4. **Budget:** atomic reserve/settle/refund, 402 path, **concurrency test**.
5. **Resilience:** timeout, bounded retry, fallback, deadline, clean 502/504, tests with a mock provider.
6. **Router:** pure `route()`, table-driven tests, reserve by routed model, `scripts/replay.js` with measured savings.
7. **Admin usage + test console:** `GET /usage`, then the single-file `public/index.html` test console from ARCHITECTURE.md section 14 (vanilla JS, no build step, no secrets stored).
8. **Deploy:** Dockerfile, host config, env on host, run migrations, smoke test with curl, README with the working example.
9. **Docs pass:** finalize DECISIONS.md and AI-LOG.md.

## Living documents you must maintain
Update both files **at the end of every phase**, in the same change as the code.

### DECISIONS.md
Required sections (keep headings): What I built (3-4 sentences); Moving parts and request lifecycle (with a diagram); Top 3-5 decisions (options considered, pick, tradeoff knowingly accepted); Why enforce budgets at the gateway (first principles); Concurrency behaviour (what happens with two simultaneous requests on a near-exhausted key, and the test that proves it); Fallback policy and why; Router policy, why it is shaped that way, and the **measured** result; What I deliberately did NOT build and why; The decision I am least confident about (argue both sides); Where it breaks and what I'd do with one more week.
Rules: record decisions as they are made with the real alternatives. Write plainly, in the author's voice. Never claim a number you did not measure.

### AI-LOG.md
Required sections: Which AI tools/models were used and for what; One place the AI was wrong or misleading and how it was caught; One place the author overrode the AI and why; How control was kept over code not typed by hand (secrets, budget logic, provider call); Something learned from scratch and how.
**Honesty rules:** log only things that actually happened. When you (the AI) make a mistake, are corrected, hit a wrong assumption (e.g. a model name or price that turned out outdated), or the author overrides you, append a dated entry immediately. **Do not invent or pre-fill the "AI was wrong" / "I overrode the AI" / "learned from scratch" entries.** If nothing has happened yet, leave a `TODO (author)` marker. The author edits this file in their own words before submitting.

## Definition of done
Concurrency, fallback, router, auth tests pass; deployed URL answers the README curl; `GET /usage` shows spend; `git log -p` and the tree contain no secrets; DECISIONS.md and AI-LOG.md are complete and truthful; every deliberate cut is named.
