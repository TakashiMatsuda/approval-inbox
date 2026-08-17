import type { Approval, AuditEvent, SqlLike, Status } from './types.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  detail TEXT,
  risk TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,
  at INTEGER NOT NULL
);
`;

function rowToApproval(r: Record<string, unknown>): Approval {
  return {
    id: r.id as string,
    action: r.action as string,
    detail: (r.detail as string) ?? null,
    risk: r.risk as Approval['risk'],
    status: r.status as Status,
    requested_by: (r.requested_by as string) ?? null,
    meta: r.meta ? JSON.parse(r.meta as string) : null,
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    decided_at: r.decided_at == null ? null : Number(r.decided_at),
    decided_by: (r.decided_by as string) ?? null,
    reason: (r.reason as string) ?? null,
  };
}

export class Store {
  constructor(private sql: SqlLike) {
    for (const stmt of SCHEMA.split(';')) {
      const s = stmt.trim();
      if (s) this.sql.exec(s);
    }
  }

  create(a: Omit<Approval, 'status' | 'decided_at' | 'decided_by' | 'reason'>): Approval {
    this.sql.exec(
      `INSERT INTO approvals (id, action, detail, risk, status, requested_by, meta, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      a.id, a.action, a.detail, a.risk, a.requested_by,
      a.meta ? JSON.stringify(a.meta) : null, a.created_at, a.expires_at,
    );
    this.audit(a.id, 'created', JSON.stringify({ risk: a.risk }));
    return this.get(a.id)!;
  }

  /** Lazily expires overdue pending approvals on read. */
  get(id: string, now = Date.now()): Approval | null {
    this.expireOverdue(now);
    const { rows } = this.sql.exec(`SELECT * FROM approvals WHERE id = ?`, id);
    return rows.length ? rowToApproval(rows[0]) : null;
  }

  list(status: Status | 'all', limit = 100, now = Date.now()): Approval[] {
    this.expireOverdue(now);
    const { rows } = status === 'all'
      ? this.sql.exec(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`, limit)
      : this.sql.exec(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit);
    return rows.map(rowToApproval);
  }

  decide(id: string, decision: 'approved' | 'denied', by: string, reason: string | null, now = Date.now()):
    { ok: true; approval: Approval } | { ok: false; error: string } {
    const a = this.get(id, now);
    if (!a) return { ok: false, error: 'not_found' };
    if (a.status !== 'pending') return { ok: false, error: `already_${a.status}` };
    this.sql.exec(
      `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ? AND status = 'pending'`,
      decision, now, by, reason, id,
    );
    this.audit(id, decision, JSON.stringify({ by, reason }));
    return { ok: true, approval: this.get(id, now)! };
  }

  events(approvalId: string): AuditEvent[] {
    const { rows } = this.sql.exec(`SELECT * FROM events WHERE approval_id = ? ORDER BY id`, approvalId);
    return rows.map(r => ({
      id: Number(r.id), approval_id: r.approval_id as string, event: r.event as string,
      data: (r.data as string) ?? null, at: Number(r.at),
    }));
  }

  audit(approvalId: string, event: string, data: string | null = null, at = Date.now()): void {
    this.sql.exec(`INSERT INTO events (approval_id, event, data, at) VALUES (?, ?, ?, ?)`, approvalId, event, data, at);
  }

  private expireOverdue(now: number): void {
    const { rows } = this.sql.exec(
      `SELECT id FROM approvals WHERE status = 'pending' AND expires_at < ?`, now);
    for (const r of rows) {
      this.sql.exec(`UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`, r.id);
      this.audit(r.id as string, 'expired', null, now);
    }
  }
}
