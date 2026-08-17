# Approval Inbox

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

Zero runtime dependencies. One process. State in SQLite (locally via `node:sqlite`, in production via a Cloudflare Durable Object).

## Quickstart (local)

```bash
npm run build
API_KEY=$(openssl rand -hex 16) SIGNING_SECRET=$(openssl rand -hex 32) npm start
# open http://localhost:8787/inbox?key=$API_KEY  ← your approval inbox
```

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
| POST | `/v1/approvals/:id/decision` | bearer | `{decision: "approve"|"deny", reason?, by?}` |
| GET | `/v1/approvals?status=pending\|all` | bearer | List / audit |
| GET | `/v1/approvals/:id/events` | bearer | Audit trail |
| GET/POST | `/d/:id?t=HMAC` | signed link | Human decision page (no login needed) |
| GET | `/inbox?key=` | key | Web inbox (auto-refresh) |

States: `pending → approved | denied | expired` (timeout). Decisions are idempotent-guarded (second decision → 409).

## Deploy to Cloudflare (production)

```bash
wrangler deploy   # uses wrangler.toml (Worker + Durable Object, SQLite-backed)
wrangler secret put API_KEY
wrangler secret put SIGNING_SECRET
```

Notifications: set `NOTIFY_URL` to any webhook (Slack incoming webhook, ntfy.sh topic, Discord). Payload: `{text, approval}`.

## Architecture

`src/core/` is a portable fetch-handler (WebCrypto only, no Node APIs) — the same code runs on node:http (`src/node/`) and Cloudflare Workers (`src/worker/`). Storage is an 8-line `SqlLike` interface implemented by both `node:sqlite` and Durable Object `storage.sql`.

## Roadmap

- Mobile push (PWA + Web Push) — currently: webhook → Slack/ntfy/LINE
- Team routing (anyone-of, escalation, vacation delegation) [paid]
- Policy engine ("spend > $50 always requires approval") [paid]
- SSO + retention controls for audit logs [paid]
- MCP server mode (approval as a tool for any MCP client)

## Domain candidates

`approvalinbox.dev` / `hitl.dev` / `pauseto.dev`

## License

Apache-2.0 — see LICENSE.
