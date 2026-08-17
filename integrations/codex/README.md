# Codex CLI integration (template)

Codex CLI (2026) supports lifecycle hooks via `hooks.json` (PreToolUse / PostToolUse).
The same `approval-gate` pattern applies: intercept the tool call, POST to Approval Inbox,
block until the human decides.

> NOTE: verify the exact hook schema against your installed Codex version
> (`codex --help hooks` / the hooks reference). This template mirrors the
> Claude Code hook and reuses the identical gate script semantics.

`~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "shell",
        "command": ["node", "/path/to/approval-inbox/integrations/codex/approval-gate-codex.mjs"],
        "timeout_seconds": 3600
      }
    ]
  }
}
```

`approval-gate-codex.mjs` is a thin wrapper that adapts Codex's hook payload
(field names differ slightly) and then delegates to the same logic as
`../claude-code/approval-gate.mjs`. Until the Codex payload is pinned down in CI,
the Claude Code script accepts both `tool_name`/`tool_input` and `tool`/`arguments`.
