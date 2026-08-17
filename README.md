# Approval Inbox

[![CI](https://github.com/TakashiMatsuda/approval-inbox/actions/workflows/ci.yml/badge.svg)](https://github.com/TakashiMatsuda/approval-inbox/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

**Human approval API for AI agents.** Your agent pauses before a dangerous action, a human gets a link/notification, taps ✓ or ✕ (with a reason), and the agent resumes — with a full audit log of who approved what, when, and why.

Works today with **Claude Code** (PreToolUse hook, included), **Codex CLI** (hooks.json template, included), and anything that can `curl`.

```bash
# agent side — one POST, then wait
curl -X POST $INBOX/v1/approvals -H "Authorization: Bearer $KEY" \
  -d '{"action":"prisma migrate deploy","risk":"high","timeout_seconds":3600}'
# → {"id":"apr_8Kd2...","status":"pending","approve_url":"https://.../d/apr_8Kd2?t=..."}

curl "$INBOX/v1/approvals/apr_8Kd2/wait?timeout=25" -H "Authorization: Bearer $KEY"
# → blocks until decided → {"status":"approved","decided_by":"takashi"}
```

Zero runtime dependencies. One Worker. State in SQLite (a Cloudflare Durable Object in production, `node:sqlite` locally).

---

## Deploy to your own Cloudflare — 5 minutes

Self-hosted by default: your approvals stay in **your** Cloudflare account, on your own domain, for about **$5/month** (Workers Paid, needed for Durable Objects).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TakashiMatsuda/approval-inbox)

**1 — Click the button** (~2 min). Cloudflare clones this repo into your GitHub account and deploys the Worker plus its Durable Object from `wrangler.toml`. You end up at `https://approval-inbox.<your-subdomain>.workers.dev`.

**2 — Set the two secrets** (~1 min). Nothing works until you do; there are no default credentials in production.

```bash
openssl rand -hex 32   # → API_KEY        (bearer token for your agents)
openssl rand -hex 32   # → SIGNING_SECRET (HMAC key for decision links)
```

Paste them in the dashboard under **Workers → your worker → Settings → Variables and Secrets** (type: Secret), or from the clone Cloudflare just made:

```bash
wrangler secret put API_KEY
wrangler secret put SIGNING_SECRET
```

**3 — Open your inbox** (~1 min).

```
https://approval-inbox.<your-subdomain>.workers.dev/inbox?key=YOUR_API_KEY
```

The key is stored in an HttpOnly cookie on that first visit and then disappears from the URL — bookmark the bare `/inbox`. Add it to your phone's home screen; that's your approval device.

**4 — Point an agent at it.**

```bash
export APPROVAL_INBOX_URL=https://approval-inbox.<your-subdomain>.workers.dev
export APPROVAL_INBOX_KEY=<your API_KEY>
./examples/demo.sh          # full create → notify → approve → resume cycle
```

Prefer the CLI for the whole thing? `git clone`, then `wrangler deploy` and the two `wrangler secret put` commands above do exactly the same work.

**Optional — get notified.** Set `NOTIFY_URL` (a plain var, not a secret) to any webhook: a Slack incoming webhook, an [ntfy.sh](https://ntfy.sh) topic, Discord. Payload is `{text, approval}`, and `text` carries the decision link, so a phone notification is one tap from a decision. Set `BASE_URL` if you put the Worker behind a custom domain, so links point at the right origin.

## 60-second demo

```bash
INBOX=https://approval-inbox.<your-subdomain>.workers.dev KEY=$API_KEY ./examples/demo.sh
```

[`examples/demo.sh`](examples/demo.sh) walks the whole loop with nothing but `curl`: an agent requests approval for a production migration, prints the decision links, blocks on `/wait`, waits for you to tap (or approves from the CLI after 20s), shows the agent resuming, and dumps the audit trail.

## Run it locally

```bash
npm run build
API_KEY=$(openssl rand -hex 16) SIGNING_SECRET=$(openssl rand -hex 32) npm start
# → http://localhost:8787/inbox?key=$API_KEY
```

Needs Node 24+ (or 22.5–23.3 with `--experimental-sqlite`, since state is `node:sqlite`). `npm test` builds and runs the e2e suite against a real spawned server.

## Claude Code integration (included)

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Write|Edit",
      "hooks": [{ "type": "command", "command": "node /path/to/integrations/claude-code/approval-gate.mjs", "timeout": 3600 }]
    }]
  }
}
```

Set `APPROVAL_INBOX_URL` and `APPROVAL_INBOX_KEY`. Dangerous patterns (`rm -rf`, `git push --force`, `terraform apply`, `DROP TABLE`, `curl | sh`, publish commands, …) are gated by default; everything else flows through Claude Code's normal permissions untouched. Customize with `APPROVAL_GATE_PATTERNS` (comma-separated regex). Denial reasons are fed back to the agent as instructions.

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/approvals` | bearer | Create request `{action, detail?, risk?, timeout_seconds?, requested_by?, meta?}` |
| GET | `/v1/approvals/:id` | bearer | Poll status |
| GET | `/v1/approvals/:id/wait?timeout=25` | bearer | Long-poll until decided |
| POST | `/v1/approvals/:id/decision` | bearer | `{decision: "approve"\|"deny", reason?, by?}` |
| GET | `/v1/approvals?status=pending\|all` | bearer | List / audit |
| GET | `/v1/approvals/:id/events` | bearer | Audit trail |
| GET/POST | `/d/:id?t=HMAC` | signed link | Human decision page (no login needed) |
| GET | `/inbox?key=` | key → cookie | Web inbox (auto-refresh) |

States: `pending → approved | denied | expired` (timeout). Decisions are idempotent-guarded (second decision → 409).

## Architecture

`src/core/` is a portable fetch-handler (WebCrypto only, no Node APIs) — the same code runs on node:http (`src/node/`) and Cloudflare Workers (`src/worker/`). Storage is an 8-line `SqlLike` interface implemented by both `node:sqlite` and Durable Object `storage.sql`.

## Security

Signed decision links are HMAC-SHA256 over `${id}.${action}`; secrets are compared in constant time; the `/inbox` cookie authenticates that read-only page only, never a decision. Full model and hardening checklist in [SECURITY.md](SECURITY.md) — that's also where to report a vulnerability (privately, via GitHub Security Advisories).

## Roadmap

- Mobile push (PWA + Web Push) — currently: webhook → Slack/ntfy/LINE
- MCP server mode (approval as a tool for any MCP client)
- Integration examples for LangGraph / CrewAI / OpenAI Agents
- Team routing (anyone-of, escalation, vacation delegation) [paid]
- Policy engine ("spend > $50 always requires approval") [paid]
- SSO + retention controls for audit logs [paid]

## License

Apache-2.0 — see [LICENSE](LICENSE).
