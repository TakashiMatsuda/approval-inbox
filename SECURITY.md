# Security Policy

Approval Inbox sits on the path between an AI agent and a dangerous action, so a
vulnerability here can mean an unapproved production change. We take reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub Security Advisories:

👉 https://github.com/TakashiMatsuda/approval-inbox/security/advisories/new

日本語でのご報告も歓迎します(英語・日本語どちらでも構いません)。

Helpful things to include:

- affected version / commit, and whether it's the Node or Cloudflare Workers deployment
- steps to reproduce (a `curl` sequence is ideal)
- impact — especially anything that lets a decision be forged, replayed, or bypassed

What to expect:

| | Target |
|---|---|
| Acknowledgement | within 72 hours |
| Initial assessment | within 7 days |
| Fix or mitigation for confirmed high-severity issues | within 30 days |

This is currently a solo-maintained project, so those are honest targets rather
than a contractual SLA. We'll credit you in the advisory unless you'd rather stay
anonymous, and we'll coordinate disclosure timing with you.

## Supported versions

Only the latest commit on `main` receives security fixes while the project is
pre-1.0. There are no long-term support branches yet.

## In scope

- forging, replaying, or bypassing a decision (`/d/:id` signed links, HMAC handling)
- authentication bypass on the JSON API or `/inbox`
- audit-log tampering: a decision that lands without a matching event row
- injection (SQL, HTML/XSS in the approval UI), which renders attacker-supplied
  `action` / `detail` / `reason` text
- secret leakage — API key or signing secret escaping into logs, URLs, or responses

## Out of scope

- anything requiring an already-leaked `API_KEY` or `SIGNING_SECRET`
- self-hosted misconfiguration: running over plain HTTP on a public network,
  a guessable API key, secrets committed to a repo
- denial of service from unthrottled request volume (rate limiting is deliberately
  left to the edge — Cloudflare WAF/Rate Limiting in front of the Worker)
- notification webhook endpoints you configure via `NOTIFY_URL`

## Security model in one paragraph

Two secrets do all the work. `API_KEY` is the bearer token for the agent-facing
JSON API and the human inbox; `SIGNING_SECRET` keys the HMAC-SHA256 over
`${id}.${action}` that makes a decision link usable without a login. Both are
compared in constant time. Signed links are single-purpose (approve or deny) and
naturally single-use, since the state machine rejects a second decision with 409.
Decisions are never accepted from a cookie — the `/inbox` session cookie authenticates
that read-only page and nothing else, so a cross-site request can't approve anything.
Deciding is `POST`-only, so a link that gets followed unattended (an unfurler, a preview
bot, a security scanner) cannot approve anything by fetching it.
Approvals expire on their own (`timeout_seconds`, max 24h), and every state change
writes an append-only `events` row.

## Hardening checklist for self-hosters

- generate real secrets: `openssl rand -hex 32` for both `API_KEY` and `SIGNING_SECRET`
- serve over HTTPS only — signed decision links are bearer credentials in a URL
- set `BASE_URL` so links point at your real origin
- rotate `SIGNING_SECRET` if a decision link may have leaked (this invalidates all
  outstanding links; pending approvals stay decidable through the API and `/inbox`)
- keep `timeout_seconds` as short as the workflow tolerates — an expired request
  fails closed
- if you set `NOTIFY_URL`, treat the destination as an approval channel: anyone who can
  read that ntfy topic or chat channel can act on the request. Use an unguessable topic
  name, prefer an access-token-protected or self-hosted topic (`NOTIFY_AUTH`), and set
  `NOTIFY_ONE_TAP=off` if notification buttons are too much authority for your setup.
  A leaked notification is scoped to the one approval it names — its token decides that
  request and nothing else
- treat the audit log (`GET /v1/approvals/:id/events`) as the record of truth and
  export it if you need retention beyond the Durable Object
