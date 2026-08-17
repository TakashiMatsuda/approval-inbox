#!/usr/bin/env node
// Claude Code PreToolUse hook → Approval Inbox.
// Reads the hook payload from stdin. If the tool call matches a dangerous pattern,
// it creates an approval request and BLOCKS until a human decides (or timeout).
//
// Install (in your project's .claude/settings.json):
// {
//   "hooks": {
//     "PreToolUse": [{
//       "matcher": "Bash|Write|Edit",
//       "hooks": [{ "type": "command", "command": "node /path/to/approval-gate.mjs", "timeout": 3600 }]
//     }]
//   }
// }
// Env: APPROVAL_INBOX_URL, APPROVAL_INBOX_KEY, APPROVAL_GATE_PATTERNS (optional, comma-separated regex)

const URL_BASE = process.env.APPROVAL_INBOX_URL ?? 'http://localhost:8787';
const API_KEY = process.env.APPROVAL_INBOX_KEY ?? 'dev-key-change-me';
const TIMEOUT_S = Number(process.env.APPROVAL_GATE_TIMEOUT ?? 1800);

const DEFAULT_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,     // rm -rf
  /\bgit\s+push\s+.*(--force|-f)\b/i,                 // force push
  /\b(prisma\s+migrate\s+deploy|alembic\s+upgrade)\b/i,
  /\b(terraform|pulumi)\s+(apply|destroy)\b/i,
  /\bkubectl\s+(delete|apply)\b/i,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,                        // curl | sh
  /\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
];

const extraPatterns = (process.env.APPROVAL_GATE_PATTERNS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean).map(s => new RegExp(s, 'i'));

function output(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision, // 'allow' | 'deny' | 'ask'
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let payload;
try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { process.exit(0); }

const toolName = payload.tool_name ?? '';
const input = payload.tool_input ?? {};
const commandText = toolName === 'Bash' ? (input.command ?? '') : JSON.stringify(input);

const matched = [...DEFAULT_PATTERNS, ...extraPatterns].find(p => p.test(commandText));
if (!matched) process.exit(0); // no opinion → Claude Code's normal permission flow

// Dangerous → require human approval via Approval Inbox
try {
  const createRes = await fetch(`${URL_BASE}/v1/approvals`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: toolName === 'Bash' ? input.command : `${toolName}: ${commandText.slice(0, 500)}`,
      detail: `Claude Code session ${payload.session_id ?? '?'} / matched: ${matched}`,
      risk: 'high',
      timeout_seconds: TIMEOUT_S,
      requested_by: 'claude-code',
      meta: { tool: toolName, cwd: payload.cwd },
    }),
  });
  if (!createRes.ok) output('ask', `Approval Inbox unreachable (${createRes.status}) — falling back to manual prompt`);
  const approval = await createRes.json();

  process.stderr.write(`⏸ waiting for human approval: ${approval.approve_url}\n`);
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const r = await fetch(`${URL_BASE}/v1/approvals/${approval.id}/wait?timeout=25`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const a = await r.json();
    if (a.status === 'approved') output('allow', `human approved (${a.decided_by ?? 'reviewer'})`);
    if (a.status === 'denied') output('deny', `human denied${a.reason ? ': ' + a.reason : ''}`);
    if (a.status === 'expired') output('deny', 'approval request expired — treat as denied');
  }
  output('deny', 'approval wait timed out — treat as denied');
} catch (err) {
  output('ask', `Approval Inbox error (${err?.message ?? err}) — falling back to manual prompt`);
}
