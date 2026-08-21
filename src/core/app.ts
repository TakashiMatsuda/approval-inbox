import type { Approval, Env, Risk, SqlLike } from './types.js';
import { Store } from './store.js';
import { notify, type DecisionLinks } from './notify.js';
import { inboxPage, decisionPage, resultPage } from './ui.js';

const enc = new TextEncoder();

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function signToken(secret: string, id: string, act: 'approve' | 'deny'): Promise<string> {
  return hmac(secret, `${id}.${act}`);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const RISKS: Risk[] = ['low', 'medium', 'high'];
const MAX_TIMEOUT = 86400;

/** Cookie holding the API key for the human web inbox (set on first `?key=` visit). */
const INBOX_COOKIE = 'ai_key';
const INBOX_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function readCookie(req: Request, name: string): string {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ''; }
  }
  return '';
}

export function createApp(sqlFactory: () => SqlLike, env: Env) {
  const store = new Store(sqlFactory());

  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const keyParam = url.searchParams.get('key') ?? '';
    const authed = timingSafeEq(bearer || keyParam, env.API_KEY);
    const base = env.BASE_URL ?? `${url.protocol}//${url.host}`;

    /** Links for notifications; `base` is request-derived, so they work without BASE_URL set. */
    const decisionLinks = async (a: Approval): Promise<DecisionLinks> => {
      const [approveToken, denyToken] = await Promise.all([
        signToken(env.SIGNING_SECRET, a.id, 'approve'),
        signToken(env.SIGNING_SECRET, a.id, 'deny'),
      ]);
      return { page: `${base}/d/${a.id}?t=${approveToken}`, post: `${base}/d/${a.id}`, approveToken, denyToken };
    };

    const serialize = async (a: Approval) => ({
      ...a,
      approve_url: `${base}/d/${a.id}?a=approve&t=${await signToken(env.SIGNING_SECRET, a.id, 'approve')}`,
      deny_url: `${base}/d/${a.id}?a=deny&t=${await signToken(env.SIGNING_SECRET, a.id, 'deny')}`,
      poll_url: `${base}/v1/approvals/${a.id}`,
    });

    // ---- POST /v1/approvals (agent creates a request) ----
    if (req.method === 'POST' && path === '/v1/approvals') {
      if (!authed) return json({ error: 'unauthorized' }, 401);
      let body: Record<string, unknown>;
      try { body = await req.json() as Record<string, unknown>; } catch { return json({ error: 'invalid_json' }, 400); }
      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (!action) return json({ error: 'action_required' }, 400);
      const risk = RISKS.includes(body.risk as Risk) ? body.risk as Risk : 'medium';
      const timeout = Math.min(Math.max(Number(body.timeout_seconds) || 3600, 5), MAX_TIMEOUT);
      const now = Date.now();
      const approval = store.create({
        id: 'apr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        action,
        detail: typeof body.detail === 'string' ? body.detail : null,
        risk,
        requested_by: typeof body.requested_by === 'string' ? body.requested_by : null,
        meta: body.meta && typeof body.meta === 'object' ? body.meta as Record<string, unknown> : null,
        created_at: now,
        expires_at: now + timeout * 1000,
      });
      await notify(env, approval, 'created', await decisionLinks(approval));
      return json(await serialize(approval), 201);
    }

    // ---- GET /v1/approvals (list) ----
    if (req.method === 'GET' && path === '/v1/approvals') {
      if (!authed) return json({ error: 'unauthorized' }, 401);
      const status = (url.searchParams.get('status') ?? 'pending') as Parameters<Store['list']>[0];
      return json({ approvals: store.list(status) });
    }

    // ---- GET /v1/approvals/:id[/wait|/events] ----
    const m = path.match(/^\/v1\/approvals\/(apr_[a-z0-9]+)(\/wait|\/events|\/decision)?$/);
    if (m) {
      const [, id, sub] = m;
      if (!authed) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'GET' && !sub) {
        const a = store.get(id);
        return a ? json(await serialize(a)) : json({ error: 'not_found' }, 404);
      }
      if (req.method === 'GET' && sub === '/wait') {
        // long-poll up to 25s
        const deadline = Date.now() + Math.min(Number(url.searchParams.get('timeout') ?? 25), 25) * 1000;
        for (;;) {
          const a = store.get(id);
          if (!a) return json({ error: 'not_found' }, 404);
          if (a.status !== 'pending' || Date.now() >= deadline) return json(await serialize(a));
          await new Promise(r => setTimeout(r, 400));
        }
      }
      if (req.method === 'GET' && sub === '/events') {
        return json({ events: store.events(id) });
      }
      if (req.method === 'POST' && sub === '/decision') {
        let body: Record<string, unknown>;
        try { body = await req.json() as Record<string, unknown>; } catch { return json({ error: 'invalid_json' }, 400); }
        const decision = body.decision === 'approve' ? 'approved' : body.decision === 'deny' ? 'denied' : null;
        if (!decision) return json({ error: 'decision_must_be_approve_or_deny' }, 400);
        const r = store.decide(id, decision, typeof body.by === 'string' ? body.by : 'api',
          typeof body.reason === 'string' ? body.reason : null);
        if (!r.ok) return json({ error: r.error }, r.error === 'not_found' ? 404 : 409);
        await notify(env, r.approval, 'decided', await decisionLinks(r.approval));
        return json(await serialize(r.approval));
      }
    }

    // ---- GET/POST /d/:id — signed decision link (no bearer needed; HMAC token is the auth) ----
    const d = path.match(/^\/d\/(apr_[a-z0-9]+)$/);
    if (d) {
      const id = d[1];
      const a = store.get(id);
      if (!a) return html(resultPage('Not found', 'この承認リクエストは存在しません。'), 404);
      if (req.method === 'GET') {
        const t = url.searchParams.get('t') ?? '';
        const okApprove = timingSafeEq(t, await signToken(env.SIGNING_SECRET, id, 'approve'));
        const okDeny = timingSafeEq(t, await signToken(env.SIGNING_SECRET, id, 'deny'));
        if (!okApprove && !okDeny) return html(resultPage('Invalid link', 'リンクが無効です。'), 403);
        if (a.status !== 'pending') return html(resultPage('決定済み', `この承認は既に ${a.status} です。`));
        return html(decisionPage(a, t));
      }
      if (req.method === 'POST') {
        const form = await req.formData();
        const act = form.get('act') === 'approve' ? 'approve' : 'deny';
        const t = String(form.get('t') ?? '');
        if (!timingSafeEq(t, await signToken(env.SIGNING_SECRET, id, act as 'approve' | 'deny')) &&
            !timingSafeEq(t, await signToken(env.SIGNING_SECRET, id, 'approve'))) {
          return html(resultPage('Invalid link', 'リンクが無効です。'), 403);
        }
        const r = store.decide(id, act === 'approve' ? 'approved' : 'denied', 'link',
          String(form.get('reason') ?? '') || null);
        if (!r.ok) return html(resultPage('決定済み', `この承認は既に処理されています(${r.error})。`), 409);
        await notify(env, r.approval, 'decided', await decisionLinks(r.approval));
        return html(resultPage(act === 'approve' ? '✅ 承認しました' : '⛔ 却下しました', r.approval.action));
      }
    }

    // ---- GET /inbox — human web UI ----
    if (req.method === 'GET' && path === '/inbox') {
      // First visit uses ?key=...; store it in an HttpOnly cookie and redirect so the key
      // stops travelling in the URL (browser history, referrers, the 10s auto-refresh).
      if (keyParam) {
        if (!authed) return html(resultPage('Unauthorized', 'API key が違います。'), 401);
        return new Response(null, {
          status: 302,
          headers: {
            location: '/inbox',
            'set-cookie': `${INBOX_COOKIE}=${encodeURIComponent(env.API_KEY)}; Path=/inbox; Max-Age=${INBOX_COOKIE_MAX_AGE}` +
              `; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`,
          },
        });
      }
      // Afterwards the cookie authenticates. Bearer still works for scripted access.
      // The cookie is deliberately accepted for this read-only page only — never for the
      // JSON API or /d/:id decisions, which would make them CSRF-able.
      if (!authed && !timingSafeEq(readCookie(req, INBOX_COOKIE), env.API_KEY)) {
        return html(resultPage('Unauthorized', '?key=YOUR_API_KEY を付けてアクセスしてください。'), 401);
      }
      const pending = store.list('pending');
      const recent = store.list('all', 20).filter(a => a.status !== 'pending');
      return html(await inboxPage(pending, recent, async (a) => ({
        approve: await signToken(env.SIGNING_SECRET, a.id, 'approve'),
        deny: await signToken(env.SIGNING_SECRET, a.id, 'deny'),
      })));
    }

    if (req.method === 'GET' && path === '/') {
      return json({ service: 'approval-inbox', docs: 'https://github.com/TakashiMatsuda/approval-inbox', endpoints: ['/v1/approvals', '/inbox'] });
    }
    return json({ error: 'not_found' }, 404);
  };
}
