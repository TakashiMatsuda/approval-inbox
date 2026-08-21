export type Risk = 'low' | 'medium' | 'high';
export type Status = 'pending' | 'approved' | 'denied' | 'expired';

export interface Approval {
  id: string;
  action: string;
  detail: string | null;
  risk: Risk;
  status: Status;
  requested_by: string | null;
  meta: Record<string, unknown> | null;
  created_at: number; // epoch ms
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  reason: string | null;
}

export interface AuditEvent {
  id: number;
  approval_id: string;
  event: string;
  data: string | null;
  at: number;
}

/** Minimal SQL surface implementable by both node:sqlite and Durable Object storage.sql */
export interface SqlLike {
  exec(sql: string, ...params: unknown[]): { rows: Record<string, unknown>[] };
}

export interface Env {
  API_KEY: string;          // bearer for agent + admin endpoints
  SIGNING_SECRET: string;   // HMAC for decision links
  NOTIFY_URL?: string;      // optional webhook: ntfy topic, Slack/Discord webhook, or any URL
  NOTIFY_FORMAT?: string;   // 'ntfy' | 'slack' | 'discord' | 'json' — auto-detected from NOTIFY_URL
  NOTIFY_AUTH?: string;     // Authorization header for the webhook (e.g. a protected ntfy topic)
  NOTIFY_ONE_TAP?: string;  // 'off' disables approve/deny buttons inside the notification (ntfy)
  BASE_URL?: string;        // public base URL used in links
}
