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

**5 — Get it on your phone** (~2 min). Point `NOTIFY_URL` at an [ntfy.sh](https://ntfy.sh) topic and every request arrives as a push notification with **✓ Approve / ✕ Deny buttons inside the notification** — decided from the lock screen, no browser. Slack, Discord, and plain webhooks work too. See [Mobile notifications](#mobile-notifications).

Prefer the CLI for the whole thing? `git clone`, then `wrangler deploy` and the two `wrangler secret put` commands above do exactly the same work.

## 60-second demo

```bash
INBOX=https://approval-inbox.<your-subdomain>.workers.dev KEY=$API_KEY ./examples/demo.sh
```

[`examples/demo.sh`](examples/demo.sh) walks the whole loop with nothing but `curl`: an agent requests approval for a production migration, prints the decision links, blocks on `/wait`, waits for you to tap (or approves from the CLI after 20s), shows the agent resuming, and dumps the audit trail.

## Mobile notifications

One variable turns a pending approval into a push notification.

| Variable | Meaning |
|---|---|
| `NOTIFY_URL` | Where to POST: an ntfy topic, a Slack/Discord webhook, or any URL of yours |
| `NOTIFY_FORMAT` | `ntfy` \| `slack` \| `discord` \| `json` — auto-detected from the host; set it explicitly for self-hosted ntfy |
| `NOTIFY_AUTH` | `Authorization` header sent with the webhook (e.g. `Bearer tk_...` for a protected ntfy topic) |
| `NOTIFY_ONE_TAP` | `off` drops the approve/deny buttons, leaving a link to the decision page |
| `BASE_URL` | Public origin for links, if the Worker sits behind a custom domain |

A webhook that hangs or fails never breaks the API: notification errors are swallowed and the call times out after 5s.

### ntfy — one tap, no browser (recommended)

1. Install the [ntfy](https://ntfy.sh) app (iOS / Android / desktop) and subscribe to a topic. **Pick an unguessable name** — `approvals-7f3a9c2e1b`, not `approvals`. On public ntfy.sh the topic name is the only thing standing between the world and your notifications.
2. Set it on the Worker. Because that topic name is password-like, store it as a secret rather than committing it to `wrangler.toml`:

   ```bash
   wrangler secret put NOTIFY_URL     # → https://ntfy.sh/approvals-7f3a9c2e1b
   ```

3. Trigger something dangerous. The notification carries **✓ Approve** and **✕ Deny**; ntfy's server performs the decision `POST` itself, so the agent resumes without you opening anything.

Risk maps to ntfy priority — `high` → 5, `medium` → 4, `low` → 3 — so low-risk requests can stay silent while a high-risk one breaks through Do Not Disturb.

**Who can approve:** anyone who can see the topic. Each button carries a signed token scoped to that one approval, so a leaked notification can decide only that single request — but treat the topic like a credential. For anything real, use a [protected topic](https://docs.ntfy.sh/config/#access-control) with an access token in `NOTIFY_AUTH`, or self-host ntfy (then set `NOTIFY_FORMAT=ntfy`, since a private host can't be auto-detected). `NOTIFY_ONE_TAP=off` falls back to link-only if you'd rather always read the full request before deciding.

### Slack / Discord

Paste an incoming-webhook URL into `NOTIFY_URL` — both are detected automatically. You get the request and a link to the decision page; the tap happens in the browser.

They can't offer one-tap buttons, by design: deciding is `POST`-only here, and a link that approved on `GET` would be approved by the first unfurler, preview bot, or link scanner that touched it. ntfy is the exception because its server issues a genuine `POST` when you press the button.

### Anything else

Any other URL receives:

```json
{ "text": "🔔 Approval requested [high]\n…", "phase": "created", "decide_url": "https://…/d/apr_8Kd2?t=…", "approval": { "id": "apr_8Kd2", "status": "pending", "…": "…" } }
```

`phase` is `created` or `decided`, so one endpoint can both alert a human and record outcomes.

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

- Mobile push: PWA + Web Push (today: ntfy one-tap, Slack, Discord, any webhook)
- MCP server mode (approval as a tool for any MCP client)
- Integration examples for LangGraph / CrewAI / OpenAI Agents
- Team routing (anyone-of, escalation, vacation delegation) [paid]
- Policy engine ("spend > $50 always requires approval") [paid]
- SSO + retention controls for audit logs [paid]

## License

Apache-2.0 — see [LICENSE](LICENSE).
