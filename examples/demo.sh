#!/usr/bin/env bash
# 60-second Approval Inbox demo: an agent asks, a human decides, the agent resumes.
#
#   INBOX=https://approval-inbox.example.workers.dev KEY=... ./examples/demo.sh
#
# Defaults to a local server (npm start). curl + coreutils only — no jq.
set -euo pipefail

INBOX="${INBOX:-${APPROVAL_INBOX_URL:-http://localhost:8787}}"
KEY="${KEY:-${APPROVAL_INBOX_KEY:-}}"
if [ -z "$KEY" ]; then
  echo "error: set KEY=<your API key> (the value you passed as API_KEY to the server)" >&2
  exit 1
fi

# Pull one top-level string field out of the (pretty-printed) JSON response.
jget() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" <<<"$2" | head -1; }

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1. agent asks
bold "1/5  Agent hits a dangerous step and requests approval"
created=$(curl -fsS -X POST "$INBOX/v1/approvals" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
        "action": "prisma migrate deploy --schema ./prod.prisma",
        "detail": "3 migrations, drops column users.legacy_id (147k rows)",
        "risk": "high",
        "requested_by": "deploy-agent",
        "timeout_seconds": 120
      }')

id=$(jget id "$created")
approve_url=$(jget approve_url "$created")
deny_url=$(jget deny_url "$created")
[ -n "$id" ] || { echo "unexpected response:"; echo "$created"; exit 1; }
dim "    created $id (status: pending, expires in 120s)"

# ------------------------------------------------------- 2. the human gets links
bold "2/5  A human gets a link (webhook/Slack/ntfy in real life)"
echo "     approve : $approve_url"
echo "     deny    : $deny_url"
echo "     inbox   : $INBOX/inbox?key=$KEY"

# --------------------------------------------------- 3. the agent blocks on wait
bold "3/5  Agent blocks on /wait (long-poll, no busy loop)"
waited_file=$(mktemp)
curl -fsS "$INBOX/v1/approvals/$id/wait?timeout=25" -H "Authorization: Bearer $KEY" >"$waited_file" &
wait_pid=$!
dim "    ...agent is paused, nothing is running against prod"

# ----------------------------------------------------------- 4. the human decides
bold "4/5  Human decides"
echo "     → tap the approve link above, or press Enter to approve from the CLI (auto in 20s)"
read -r -t 20 _ || true

status=$(jget status "$(curl -fsS "$INBOX/v1/approvals/$id" -H "Authorization: Bearer $KEY")")
if [ "$status" = "pending" ]; then
  dim "    no human tap — approving via the API so the demo finishes"
  curl -fsS -X POST "$INBOX/v1/approvals/$id/decision" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"decision":"approve","by":"demo","reason":"looks good"}' >/dev/null
fi

# --------------------------------------------------------------- 5. agent resumes
wait "$wait_pid" || true
resumed=$(cat "$waited_file"); rm -f "$waited_file"
final=$(jget status "$resumed")
by=$(jget decided_by "$resumed")

bold "5/5  Agent resumes"
echo "     /wait returned: $final (by ${by:-unknown})"
if [ "$final" = "approved" ]; then
  echo "     ✅ agent proceeds with the migration"
else
  echo "     ⛔ agent aborts; the reason is fed back as an instruction"
fi

bold "Audit log"
curl -fsS "$INBOX/v1/approvals/$id/events" -H "Authorization: Bearer $KEY" |
  sed -n 's/.*"event": *"\([^"]*\)".*/     · \1/p'
