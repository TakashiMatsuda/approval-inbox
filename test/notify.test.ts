import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotification, detectFormat } from '../src/core/notify.js';
import type { Approval, Env } from '../src/core/types.js';

// ---------------------------------------------------------------- unit: payload shapes

const APPROVAL: Approval = {
  id: 'apr_abc123', action: 'prisma migrate deploy', detail: 'drops users.legacy_id',
  risk: 'high', status: 'pending', requested_by: 'deploy-agent', meta: null,
  created_at: 1_700_000_000_000, expires_at: 1_700_000_600_000,
  decided_at: null, decided_by: null, reason: null,
};
const LINKS = {
  page: 'https://inbox.example.com/d/apr_abc123?t=APPROVETOKEN',
  post: 'https://inbox.example.com/d/apr_abc123',
  approveToken: 'APPROVETOKEN', denyToken: 'DENYTOKEN',
};
const env = (over: Partial<Env>): Env => ({ API_KEY: 'k', SIGNING_SECRET: 's', ...over });
const built = (over: Partial<Env>, phase: 'created' | 'decided' = 'created', a: Approval = APPROVAL) =>
  buildNotification(env(over), a, phase, LINKS)!;

test('no NOTIFY_URL → no notification at all', () => {
  assert.equal(buildNotification(env({}), APPROVAL, 'created', LINKS), null);
});

test('format is detected from the host, and NOTIFY_FORMAT overrides it', () => {
  assert.equal(detectFormat(env({ NOTIFY_URL: 'https://ntfy.sh/my-topic' })), 'ntfy');
  assert.equal(detectFormat(env({ NOTIFY_URL: 'https://hooks.slack.com/services/T/B/x' })), 'slack');
  assert.equal(detectFormat(env({ NOTIFY_URL: 'https://discord.com/api/webhooks/1/x' })), 'discord');
  assert.equal(detectFormat(env({ NOTIFY_URL: 'https://example.com/hook' })), 'json');
  // self-hosted ntfy can't be guessed — it must be declared
  assert.equal(detectFormat(env({ NOTIFY_URL: 'https://push.mydomain.dev/approvals' })), 'json');
  assert.equal(detectFormat(env({ NOTIFY_URL: 'https://push.mydomain.dev/approvals', NOTIFY_FORMAT: 'ntfy' })), 'ntfy');
});

test('ntfy: topic moves from the URL into the body, published to the server root', () => {
  const r = built({ NOTIFY_URL: 'https://ntfy.sh/my-topic' });
  assert.equal(r.url, 'https://ntfy.sh/');
  const b = JSON.parse(r.body);
  assert.equal(b.topic, 'my-topic');
  assert.match(b.title, /Approval requested/);
  assert.match(b.message, /prisma migrate deploy/);
  assert.equal(b.priority, 5); // high risk

  const selfHosted = built({ NOTIFY_URL: 'https://push.mydomain.dev/ops/approvals', NOTIFY_FORMAT: 'ntfy' });
  assert.equal(selfHosted.url, 'https://push.mydomain.dev/ops/');
  assert.equal(JSON.parse(selfHosted.body).topic, 'approvals');
});

test('ntfy: priority tracks risk', () => {
  const at = (risk: Approval['risk']) =>
    JSON.parse(built({ NOTIFY_URL: 'https://ntfy.sh/t' }, 'created', { ...APPROVAL, risk }).body).priority;
  assert.deepEqual([at('high'), at('medium'), at('low')], [5, 4, 3]);
});

test('ntfy: one-tap buttons carry a real form-encoded decision', () => {
  const b = JSON.parse(built({ NOTIFY_URL: 'https://ntfy.sh/t' }).body);
  assert.equal(b.actions.length, 3, 'ntfy allows at most three buttons');
  const [approve, deny, view] = b.actions;

  assert.equal(approve.action, 'http');
  assert.equal(approve.method, 'POST');
  assert.equal(approve.url, LINKS.post);
  assert.equal(approve.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([...new URLSearchParams(approve.body)], [['act', 'approve'], ['t', 'APPROVETOKEN']]);
  assert.equal(approve.clear, true);

  // deny must use the deny token, not the approve one
  assert.deepEqual([...new URLSearchParams(deny.body)], [['act', 'deny'], ['t', 'DENYTOKEN']]);

  assert.equal(view.action, 'view');
  assert.equal(view.url, LINKS.page);
});

test('ntfy: NOTIFY_ONE_TAP=off leaves only the link', () => {
  const b = JSON.parse(built({ NOTIFY_URL: 'https://ntfy.sh/t', NOTIFY_ONE_TAP: 'off' }).body);
  assert.deepEqual(b.actions.map((a: { action: string }) => a.action), ['view']);
});

test('decided notifications never carry decision buttons', () => {
  const decided: Approval = { ...APPROVAL, status: 'approved', decided_at: 1, decided_by: 'takashi', reason: 'ok' };
  const b = JSON.parse(built({ NOTIFY_URL: 'https://ntfy.sh/t' }, 'decided', decided).body);
  assert.equal(b.actions, undefined);
  assert.match(b.title, /Approved/);
  assert.match(b.message, /reason: ok/);
});

test('slack uses `text` and escapes the three reserved characters', () => {
  const a: Approval = { ...APPROVAL, action: 'psql -c "select * from t where a < b & c > d"' };
  const b = JSON.parse(built({ NOTIFY_URL: 'https://hooks.slack.com/services/T/B/x' }, 'created', a).body);
  assert.ok(typeof b.text === 'string');
  assert.match(b.text, /&lt;/);
  assert.match(b.text, /&gt;/);
  assert.match(b.text, /&amp;/);
  assert.ok(!/[<>]\s*b\b/.test(b.text.replace(/<https[^>]*>/g, '')), 'raw angle brackets must not survive');
  assert.match(b.text, new RegExp(`<${LINKS.page.replace(/[?]/g, '\\?')}\\|`), 'links use Slack <url|label> form');
});

test('discord uses `content`', () => {
  const b = JSON.parse(built({ NOTIFY_URL: 'https://discord.com/api/webhooks/1/x' }).body);
  assert.ok(typeof b.content === 'string');
  assert.match(b.content, /prisma migrate deploy/);
  assert.match(b.content, /https:\/\/inbox\.example\.com\/d\/apr_abc123/);
});

test('generic json keeps {text, approval} and adds the decision link', () => {
  const r = built({ NOTIFY_URL: 'https://example.com/hook' });
  assert.equal(r.url, 'https://example.com/hook');
  const b = JSON.parse(r.body);
  assert.equal(b.phase, 'created');
  assert.equal(b.decide_url, LINKS.page);
  assert.equal(b.approval.id, 'apr_abc123');
  assert.match(b.text, /Approval requested/);
});

test('NOTIFY_AUTH is sent as the Authorization header', () => {
  const r = built({ NOTIFY_URL: 'https://ntfy.sh/t', NOTIFY_AUTH: 'Bearer tk_secret' });
  assert.equal(r.headers.authorization, 'Bearer tk_secret');
  assert.equal(built({ NOTIFY_URL: 'https://ntfy.sh/t' }).headers.authorization, undefined);
});

// ---------------------------------------------------------------- e2e: the wire actually moves

const HOOK_PORT = 18901;
const APP_PORT = 18902;
const APP = `http://localhost:${APP_PORT}`;
const KEY = 'test-api-key';

let hook: Server;
let app: ChildProcess;
const received: Record<string, unknown>[] = [];

before(async () => {
  hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      try { received.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* ignore */ }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>(r => hook.listen(HOOK_PORT, r));

  const dir = mkdtempSync(join(tmpdir(), 'inbox-notify-'));
  app = spawn('node', ['dist/src/node/server.js', '--port', String(APP_PORT), '--db', join(dir, 't.db')], {
    env: {
      ...process.env, API_KEY: KEY, SIGNING_SECRET: 'test-signing-secret',
      NOTIFY_URL: `http://127.0.0.1:${HOOK_PORT}/hook`,
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(APP + '/'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(() => { app.kill(); hook.close(); });

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${APP}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

async function waitForHooks(n: number): Promise<void> {
  for (let i = 0; i < 50 && received.length < n; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(received.length >= n, `expected ${n} webhook call(s), got ${received.length}`);
}

test('webhook fires on create and on decision, with an absolute decision link', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'notify-me', risk: 'low', requested_by: 'agent' }),
  })).json();

  await waitForHooks(1);
  const created = received[0];
  assert.equal(created.phase, 'created');
  assert.equal((created.approval as Approval).id, a.id);
  // BASE_URL is unset here: the link must still be absolute, or a phone can't open it.
  assert.equal(created.decide_url, `${APP}/d/${a.id}?t=${new URL(a.approve_url).searchParams.get('t')}`);

  await api(`/v1/approvals/${a.id}/decision`, {
    method: 'POST', body: JSON.stringify({ decision: 'approve', by: 'takashi' }),
  });
  await waitForHooks(2);
  assert.equal(received[1].phase, 'decided');
  assert.match(received[1].text as string, /Approved/);
});

test('an ntfy one-tap button body really decides', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'one-tap-deny', risk: 'high' }),
  })).json();

  // Build the notification the way production would, then replay its deny button verbatim.
  const payload = JSON.parse(buildNotification(
    env({ NOTIFY_URL: 'https://ntfy.sh/t' }), a, 'created',
    {
      page: a.approve_url, post: `${APP}/d/${a.id}`,
      approveToken: new URL(a.approve_url).searchParams.get('t')!,
      denyToken: new URL(a.deny_url).searchParams.get('t')!,
    },
  )!.body);
  const denyButton = payload.actions[1];

  const res = await fetch(denyButton.url, {
    method: denyButton.method, headers: denyButton.headers, body: denyButton.body,
  });
  assert.equal(res.status, 200);
  const got = await (await api(`/v1/approvals/${a.id}`)).json();
  assert.equal(got.status, 'denied');
  assert.equal(got.decided_by, 'link');
});
