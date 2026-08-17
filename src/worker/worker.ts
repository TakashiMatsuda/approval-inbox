// Cloudflare Workers entry. All state lives in a single Durable Object (SQLite-backed).
// NOTE: written for wrangler deploy; not executed in the dev sandbox (no workerd available).
import { createApp } from '../core/app.js';
import type { Env as CoreEnv, SqlLike } from '../core/types.js';

export interface WorkerEnv extends CoreEnv {
  INBOX: DurableObjectNamespace;
}

export class InboxDO {
  private handler: (req: Request) => Promise<Response>;

  constructor(private ctx: DurableObjectState, env: WorkerEnv) {
    const sql: SqlLike = {
      exec: (q: string, ...params: unknown[]) => ({
        rows: ctx.storage.sql.exec(q, ...params).toArray() as Record<string, unknown>[],
      }),
    };
    this.handler = createApp(() => sql, env);
  }

  fetch(req: Request): Promise<Response> {
    return this.handler(req);
  }
}

export default {
  fetch(req: Request, env: WorkerEnv): Promise<Response> {
    // Single-tenant MVP: one DO instance. Multi-tenant: derive the DO id from the API key / org.
    const id = env.INBOX.idFromName('default');
    return env.INBOX.get(id).fetch(req);
  },
};

// Minimal ambient types so this compiles without @cloudflare/workers-types installed.
declare global {
  interface DurableObjectNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
  interface DurableObjectState { storage: { sql: { exec(q: string, ...p: unknown[]): { toArray(): unknown[] } } } }
}
