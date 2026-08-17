import type { Approval } from './types.js';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const shell = (title: string, body: string) => `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Approval Inbox</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans',sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px;max-width:760px;margin-inline:auto}
 h1{font-size:18px} .card{background:#161b22;border:1px solid #2d333b;border-radius:10px;padding:16px;margin:12px 0}
 .risk{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;margin-left:8px}
 .high{background:#3d1d1f;color:#ff8a85}.medium{background:#3a2e15;color:#e3b341}.low{background:#1f4d2e;color:#7ee787}
 .action{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#010409;border:1px solid #2d333b;border-radius:6px;padding:8px 10px;margin:8px 0;word-break:break-all}
 .detail{color:#8b949e;font-size:13px;line-height:1.6}
 button{border:none;border-radius:7px;padding:9px 20px;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit}
 .ok{background:#238636;color:#fff}.ng{background:#da3633;color:#fff;margin-left:8px}
 input[type=text]{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #2d333b;border-radius:6px;color:#e6edf3;padding:8px;margin:8px 0;font-family:inherit}
 .muted{color:#8b949e;font-size:12px} .status{font-weight:700;font-size:12px}
 .approved{color:#3fb950}.denied{color:#f85149}.expired{color:#8b949e}
</style></head><body>${body}</body></html>`;

export function decisionPage(a: Approval, token: string): string {
  return shell('承認リクエスト', `
  <h1>承認リクエスト <span class="risk ${a.risk}">${a.risk.toUpperCase()}</span></h1>
  <div class="card">
    <div class="action">${esc(a.action)}</div>
    ${a.detail ? `<p class="detail">${esc(a.detail)}</p>` : ''}
    <p class="muted">requested_by: ${esc(a.requested_by ?? 'unknown')} ・ 期限: ${new Date(a.expires_at).toLocaleString('ja-JP')}</p>
    <form method="POST">
      <input type="hidden" name="t" value="${esc(token)}">
      <input type="text" name="reason" placeholder="理由(任意 — 却下時はエージェントへの指示になります)">
      <button class="ok" name="act" value="approve">✓ 承認</button>
      <button class="ng" name="act" value="deny">✕ 却下</button>
    </form>
  </div>`);
}

export function resultPage(title: string, message: string): string {
  return shell(title, `<h1>${esc(title)}</h1><div class="card"><p>${esc(message)}</p></div>`);
}

export async function inboxPage(
  pending: Approval[], recent: Approval[], apiKey: string,
  tokens: (a: Approval) => Promise<{ approve: string; deny: string }>,
): Promise<string> {
  const pendingCards = await Promise.all(pending.map(async a => {
    const t = await tokens(a);
    return `<div class="card">
      <span class="risk ${a.risk}">${a.risk.toUpperCase()}</span>
      <div class="action">${esc(a.action)}</div>
      ${a.detail ? `<p class="detail">${esc(a.detail)}</p>` : ''}
      <p class="muted">${esc(a.requested_by ?? 'unknown')} ・ ${new Date(a.created_at).toLocaleString('ja-JP')}</p>
      <form method="POST" action="/d/${a.id}">
        <input type="hidden" name="t" value="${esc(t.approve)}">
        <input type="text" name="reason" placeholder="理由(任意)">
        <button class="ok" name="act" value="approve">✓ 承認</button>
        <button class="ng" name="act" value="deny">✕ 却下</button>
      </form>
    </div>`;
  }));
  const recentRows = recent.map(a =>
    `<div class="card"><span class="status ${a.status}">${a.status}</span>
     <div class="action">${esc(a.action)}</div>
     ${a.reason ? `<p class="detail">理由: ${esc(a.reason)}</p>` : ''}
     <p class="muted">${a.decided_by ? 'by ' + esc(a.decided_by) + ' ・ ' : ''}${new Date(a.decided_at ?? a.created_at).toLocaleString('ja-JP')}</p></div>`).join('');
  return shell('Inbox', `
  <h1>📥 Approval Inbox <span class="muted">(auto-refresh 10s)</span></h1>
  <meta http-equiv="refresh" content="10">
  ${pendingCards.length ? pendingCards.join('') : '<div class="card muted">承認待ちはありません</div>'}
  <h1 style="margin-top:28px">履歴</h1>${recentRows || '<div class="card muted">まだ履歴がありません</div>'}`);
}
