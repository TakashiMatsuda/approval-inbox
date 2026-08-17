import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18787;
const BASE = `http://localhost:${PORT}`;
const KEY = 'test-api-key';
let server: ChildProcess;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  server = spawn('node', ['dist/src/node/server.js', '--port', String(PORT), '--db', join(dir, 't.db')], {
    env: { ...process.env, API_KEY: KEY, SIGNING_SECRET: 'test-signing-secret' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => server.kill());

test('unauthorized requests are rejected', async () => {
  const r = await fetch(`${BASE}/v1/approvals`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
});

test('create → poll → approve via API', async () => {
  const created = await api('/v1/approvals', {
    method: 'POST',
    body: JSON.stringify({ action: 'prisma migrate deploy', risk: 'high', timeout_seconds: 600, requested_by: 'deploy-agent' }),
  });
  assert.equal(created.status, 201);
  const a = await created.json();
  assert.equal(a.status, 'pending');
  assert.match(a.id, /^apr_/);
  assert.ok(a.approve_url.includes('/d/' + a.id));

  const polled = await (await api(`/v1/approvals/${a.id}`)).json();
  assert.equal(polled.status, 'pending');

  const decided = await api(`/v1/approvals/${a.id}/decision`, {
    method: 'POST', body: JSON.stringify({ decision: 'approve', by: 'takashi' }),
  });
  assert.equal(decided.status, 200);
  const done = await decided.json();
  assert.equal(done.status, 'approved');
  assert.equal(done.decided_by, 'takashi');

  // double-decide → 409
  const again = await api(`/v1/approvals/${a.id}/decision`, {
    method: 'POST', body: JSON.stringify({ decision: 'deny' }),
  });
  assert.equal(again.status, 409);
});

test('deny with reason reaches the agent', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'rm -rf /prod', risk: 'high' }),
  })).json();
  await api(`/v1/approvals/${a.id}/decision`, {
    method: 'POST', body: JSON.stringify({ decision: 'deny', reason: '金曜夜はDB変更禁止', by: 'takashi' }),
  });
  const got = await (await api(`/v1/approvals/${a.id}`)).json();
  assert.equal(got.status, 'denied');
  assert.equal(got.reason, '金曜夜はDB変更禁止');
});

test('signed decision link works without bearer auth; bad token rejected', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'git push --force origin main' }),
  })).json();
  const approveUrl = new URL(a.approve_url);

  const bad = await fetch(`${BASE}${approveUrl.pathname}?t=WRONGTOKEN`);
  assert.equal(bad.status, 403);

  const page = await fetch(`${BASE}${approveUrl.pathname}?${approveUrl.searchParams}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /承認リクエスト/);

  const form = new URLSearchParams({ act: 'approve', t: approveUrl.searchParams.get('t')!, reason: 'ok' });
  const decided = await fetch(`${BASE}${approveUrl.pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  });
  assert.equal(decided.status, 200);
  const got = await (await api(`/v1/approvals/${a.id}`)).json();
  assert.equal(got.status, 'approved');
});

test('timeout expires a pending approval', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'sleep-test', timeout_seconds: 5 }),
  })).json();
  // timeout_seconds is clamped to >=5; simulate by waiting past expiry
  await new Promise(r => setTimeout(r, 5200));
  const got = await (await api(`/v1/approvals/${a.id}`)).json();
  assert.equal(got.status, 'expired');
  const dec = await api(`/v1/approvals/${a.id}/decision`, {
    method: 'POST', body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(dec.status, 409); // already_expired
});

test('wait endpoint long-polls until decision', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'kubectl apply -f prod.yaml' }),
  })).json();
  const t0 = Date.now();
  const waitP = api(`/v1/approvals/${a.id}/wait?timeout=10`).then(r => r.json());
  setTimeout(() => {
    api(`/v1/approvals/${a.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  }, 1200);
  const result = await waitP;
  const elapsed = Date.now() - t0;
  assert.equal(result.status, 'approved');
  assert.ok(elapsed >= 1000 && elapsed < 9000, `long-poll returned in ${elapsed}ms`);
});

test('list + audit events', async () => {
  const a = await (await api('/v1/approvals', {
    method: 'POST', body: JSON.stringify({ action: 'audit-me' }),
  })).json();
  const pending = await (await api('/v1/approvals?status=pending')).json();
  assert.ok(pending.approvals.some((x: { id: string }) => x.id === a.id));
  await api(`/v1/approvals/${a.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny', by: 'qa' }) });
  const events = await (await api(`/v1/approvals/${a.id}/events`)).json();
  const names = events.events.map((e: { event: string }) => e.event);
  assert.deepEqual(names, ['created', 'denied']);
});

test('inbox UI renders pending approvals', async () => {
  await api('/v1/approvals', { method: 'POST', body: JSON.stringify({ action: 'show-me-in-inbox', risk: 'low' }) });
  const r = await fetch(`${BASE}/inbox?key=${KEY}`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /show-me-in-inbox/);
  const noAuth = await fetch(`${BASE}/inbox`);
  assert.equal(noAuth.status, 401);
});
