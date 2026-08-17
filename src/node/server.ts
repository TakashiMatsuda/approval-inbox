// Node adapter: runs the portable fetch-handler on node:http with node:sqlite storage.
// Usage: node dist/node/server.js [--port 8787] [--db approvals.db]
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../core/app.js';
import type { Env, SqlLike } from '../core/types.js';

function sqliteAdapter(path: string): SqlLike {
  const db = new DatabaseSync(path);
  return {
    exec(sql: string, ...params: unknown[]) {
      const stmt = db.prepare(sql);
      if (/^\s*select/i.test(sql)) {
        return { rows: stmt.all(...(params as never[])) as Record<string, unknown>[] };
      }
      stmt.run(...(params as never[]));
      return { rows: [] };
    },
  };
}

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const port = Number(flag('port', process.env.PORT ?? '8787'));
const dbPath = flag('db', process.env.DB_PATH ?? 'approvals.db');

const env: Env = {
  API_KEY: process.env.API_KEY ?? 'dev-key-change-me',
  SIGNING_SECRET: process.env.SIGNING_SECRET ?? 'dev-secret-change-me',
  NOTIFY_URL: process.env.NOTIFY_URL,
  BASE_URL: process.env.BASE_URL,
};

const handler = createApp(() => sqliteAdapter(dbPath), env);

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
  });
  try {
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal', detail: String(err) }));
  }
});

server.listen(port, () => {
  console.log(`approval-inbox listening on http://localhost:${port}  (db: ${dbPath})`);
  if (env.API_KEY === 'dev-key-change-me') console.log('⚠ using default dev API_KEY — set API_KEY in production');
});
