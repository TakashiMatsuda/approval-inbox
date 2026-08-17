# CLAUDE.md — approval-inbox

## What this is
Human approval API for AI agents (pause → notify human → tap approve/deny → agent resumes, full audit log). Part of a 3-service portfolio (approval-inbox = P1/top priority, databeam, verified-lane) decided 2026-08-17. Strategy: OSS core (Apache-2.0) + paid hosted version. Infra: Cloudflare Workers + Durable Objects, ~$5/mo.

## Architecture (do not break these invariants)
- `src/core/` is a **portable fetch-handler**: WebCrypto only, no Node-specific APIs. The same code runs on node:http (`src/node/server.ts`) and Cloudflare Workers (`src/worker/worker.ts`).
- Storage goes through the 8-line `SqlLike` interface (`src/core/types.ts`), implemented by `node:sqlite` locally and Durable Object `storage.sql` in production. Keep all SQL compatible with both.
- **Zero runtime dependencies.** Keep it that way; it is a selling point and removes supply-chain risk for a security-adjacent product.
- State machine: `pending → approved | denied | expired` (lazy expiry on read). Double-decide returns 409.
- Signed decision links: HMAC-SHA256 over `${id}.${action}` with SIGNING_SECRET, base64url.

## Build & test
```
npm run build   # tsc (Node >=22.5 for node:sqlite)
npm test        # builds + node --test dist/test/e2e.test.js  (8 tests, all must pass)
```
The Claude Code hook integration (`integrations/claude-code/approval-gate.mjs`) was verified end-to-end: dangerous command → blocks → API approval → outputs permissionDecision allow. Test it manually per README if you touch it.

## Current status (2026-08-17)
MVP complete, 8/8 e2e tests pass. Not yet deployed (needs the owner's Cloudflare account: `wrangler deploy`, then `wrangler secret put API_KEY / SIGNING_SECRET`). `src/worker/` compiles standalone but has NOT run on real workerd yet — first deploy should verify DO storage.sql param binding syntax.

## Near-term roadmap (in priority order)
1. Verify + fix Worker/DO entry on real Cloudflare (first `wrangler deploy`)
2. Mobile notifications: webhook → ntfy.sh/Slack docs, then PWA + Web Push
3. MCP server mode (approval as an MCP tool) — reuse core, big distribution win
4. Integration examples for LangGraph / CrewAI / OpenAI Agents (drives adoption)
5. Paid tier: team routing (anyone-of, escalation), policy engine, SSO — only after traction

## Conventions
- TypeScript strict, NodeNext modules, no default exports except Worker entry.
- Tests are e2e-first (spawn real server, real HTTP). Add unit tests only for pure logic.
- 日本語UIとEnglish APIの併存は意図的(初期ターゲットは日英両方)。
