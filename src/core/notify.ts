// Outbound notifications: how a pending approval reaches a human's phone.
//
// Payload building is a pure function (buildNotification) so it can be unit-tested without
// a network; only `notify` touches fetch. Portable — no Node APIs, no dependencies.
//
// ntfy is the one transport that can decide in a single tap: its `http` actions are performed
// by the ntfy server, so a notification button can POST the decision directly. Slack/Discord
// links are GETs, and link unfurlers/scanners follow those unattended, so those formats only
// ever link to the decision page — deciding stays POST-only everywhere.
import type { Approval, Env, Risk } from './types.js';

export type NotifyPhase = 'created' | 'decided';
export type NotifyFormat = 'ntfy' | 'slack' | 'discord' | 'json';

/** Everything a notification needs to offer a decision. `post` takes form-encoded one-tap decisions. */
export interface DecisionLinks {
  page: string;          // GET: human decision page (approve token; the page offers both buttons)
  post: string;          // POST target for `act` + `t`
  approveToken: string;
  denyToken: string;
}

export interface NotifyRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const TIMEOUT_MS = 5000;
const FORMATS: NotifyFormat[] = ['ntfy', 'slack', 'discord', 'json'];
const NTFY_PRIORITY: Record<Risk, number> = { high: 5, medium: 4, low: 3 };
const NTFY_TAG: Record<Risk, string> = { high: 'rotating_light', medium: 'warning', low: 'bell' };

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** Explicit NOTIFY_FORMAT wins; otherwise guess from the host (self-hosted ntfy must be explicit). */
export function detectFormat(env: Env): NotifyFormat {
  const explicit = (env.NOTIFY_FORMAT ?? '').trim().toLowerCase() as NotifyFormat;
  if (FORMATS.includes(explicit)) return explicit;
  let host: string;
  try { host = new URL(env.NOTIFY_URL ?? '').hostname.toLowerCase(); } catch { return 'json'; }
  if (host === 'hooks.slack.com') return 'slack';
  if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) return 'discord';
  if (host === 'ntfy.sh' || host.endsWith('.ntfy.sh')) return 'ntfy';
  return 'json';
}

/** ntfy publishes JSON to the server root with the topic in the body: split it off the URL. */
function ntfyTarget(raw: string): { url: string; topic: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const segments = u.pathname.split('/').filter(Boolean);
  const topic = segments.pop();
  if (!topic) return null;
  u.pathname = segments.length ? `/${segments.join('/')}/` : '/';
  u.search = '';
  u.hash = '';
  return { url: u.toString(), topic };
}

const emoji = (a: Approval, phase: NotifyPhase) =>
  phase === 'created' ? '🔔' : a.status === 'approved' ? '✅' : a.status === 'denied' ? '⛔' : '⌛';

const headline = (a: Approval, phase: NotifyPhase) =>
  phase === 'created'
    ? `Approval requested [${a.risk}]`
    : a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : 'Expired';

function lines(a: Approval, phase: NotifyPhase): string[] {
  const out = [clip(a.action, 300)];
  if (phase === 'created') {
    if (a.detail) out.push(clip(a.detail, 500));
    out.push(`requested by ${a.requested_by ?? 'unknown'} · expires ${new Date(a.expires_at).toISOString().slice(11, 16)} UTC`);
  } else {
    if (a.reason) out.push(`reason: ${clip(a.reason, 300)}`);
    if (a.decided_by) out.push(`by ${a.decided_by}`);
  }
  return out;
}

/** Plain-text rendering used by the generic and Discord formats. */
function plain(a: Approval, phase: NotifyPhase, links: DecisionLinks): string {
  const body = [`${emoji(a, phase)} ${headline(a, phase)}`, ...lines(a, phase)];
  if (phase === 'created') body.push(`Decide: ${links.page}`);
  return body.join('\n');
}

const oneTap = (env: Env) => (env.NOTIFY_ONE_TAP ?? '').trim().toLowerCase() !== 'off';
const form = (act: 'approve' | 'deny', token: string) => new URLSearchParams({ act, t: token }).toString();

function ntfyPayload(env: Env, a: Approval, phase: NotifyPhase, links: DecisionLinks, topic: string) {
  const payload: Record<string, unknown> = {
    topic,
    title: `${emoji(a, phase)} ${headline(a, phase)}`,
    message: lines(a, phase).join('\n'),
    priority: phase === 'created' ? NTFY_PRIORITY[a.risk] : 3,
    tags: [phase === 'created'
      ? NTFY_TAG[a.risk]
      : a.status === 'approved' ? 'white_check_mark' : a.status === 'denied' ? 'no_entry' : 'hourglass'],
  };
  if (phase !== 'created') return payload;

  const view = { action: 'view', label: 'Open', url: links.page };
  // ntfy allows at most three action buttons; the ntfy server performs `http` ones itself,
  // so approve/deny happen from the notification without opening a browser.
  payload.actions = oneTap(env)
    ? [
        { action: 'http', label: '✓ Approve', url: links.post, method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form('approve', links.approveToken), clear: true },
        { action: 'http', label: '✕ Deny', url: links.post, method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form('deny', links.denyToken), clear: true },
        view,
      ]
    : [view];
  return payload;
}

/** Slack requires these three escaped in message text; everything else is literal. */
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slackText(a: Approval, phase: NotifyPhase, links: DecisionLinks): string {
  const [action, ...rest] = lines(a, phase);
  const out = [
    `${emoji(a, phase)} *${headline(a, phase)}*`,
    '```' + slackEscape(action) + '```',
    ...rest.map(slackEscape),
  ];
  if (phase === 'created') out.push(`<${links.page}|Open decision page>`);
  return out.join('\n');
}

/**
 * Render the webhook call for one approval event, or null when notifications are off.
 * Pure: no I/O, so the wire shape of every supported provider is unit-testable.
 */
export function buildNotification(
  env: Env, approval: Approval, phase: NotifyPhase, links: DecisionLinks,
): NotifyRequest | null {
  if (!env.NOTIFY_URL) return null;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.NOTIFY_AUTH) headers.authorization = env.NOTIFY_AUTH;

  const format = detectFormat(env);
  if (format === 'ntfy') {
    const target = ntfyTarget(env.NOTIFY_URL);
    // No topic in the URL — fall back to the generic shape rather than publishing nowhere.
    if (target) {
      return { url: target.url, headers, body: JSON.stringify(ntfyPayload(env, approval, phase, links, target.topic)) };
    }
  } else if (format === 'slack') {
    return { url: env.NOTIFY_URL, headers, body: JSON.stringify({ text: slackText(approval, phase, links) }) };
  } else if (format === 'discord') {
    return { url: env.NOTIFY_URL, headers, body: JSON.stringify({ content: clip(plain(approval, phase, links), 1900) }) };
  }
  // Generic: `text` for humans, `approval` for anything that wants the structured record.
  return {
    url: env.NOTIFY_URL,
    headers,
    body: JSON.stringify({ text: plain(approval, phase, links), phase, decide_url: links.page, approval }),
  };
}

export async function notify(
  env: Env, approval: Approval, phase: NotifyPhase, links: DecisionLinks,
): Promise<void> {
  const req = buildNotification(env, approval, phase, links);
  if (!req) return;
  try {
    await fetch(req.url, {
      method: 'POST', headers: req.headers, body: req.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { /* a slow or broken webhook must never break the approval API */ }
}
