import { spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Raw-socket "held body" requests for the write-time re-check tests (#157, #159).
 *
 * The request line and headers go out first; the body is withheld until the test
 * calls `finish()`. Whatever the test does in between (turn auth on, deactivate
 * the caller, switch profile) happens while the server is parked on the body.
 *
 * `arrived` replaces a fixed sleep: it resolves once the server's arrival
 * middleware has read the auth flag from `db` for this request. That read is the
 * first thing a request does after its headers arrive, and the server then runs
 * synchronously until it parks on the body, so by the time the test resumes
 * from `await arrived` the request has been authenticated and is waiting. A slow
 * runner cannot make the test race ahead of the arrival middleware (which
 * would turn the case into a plain 401 for the wrong reason).
 */

export interface HeldRequest {
  /** Resolves when the server has seen this request's headers and is waiting for the body. */
  arrived: Promise<void>;
  /** Send the body and read the whole response. */
  finish: () => Promise<{ status: number; body: string }>;
}

export interface HeldRequestInit {
  method: string;
  path: string;
  /** Extra headers (Authorization, Origin, ...). */
  headers?: Record<string, string>;
  /** Already-serialised body. */
  payload: string;
}

/**
 * Resolves the first time the server's arrival middleware reads `db`'s auth flag after this call (that read is
 * the first thing every request does once its headers arrive). Install it BEFORE sending the request. The spy
 * removes itself as soon as it has fired.
 */
export function nextArrival(db: Database): Promise<void> {
  const originalPrepare = db.prepare.bind(db);
  let markArrived!: () => void;
  const arrived = new Promise<void>((resolve) => (markArrived = resolve));
  const spy = spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes("key = 'auth_enabled'")) markArrived();
    return originalPrepare(sql);
  }) as typeof db.prepare);
  // Restore as soon as the request has been seen so the spy never outlives the wait.
  void arrived.then(() => spy.mockRestore());
  return arrived;
}

/** Open a held request against `server`; `db` is the connection the arrival middleware reads auth from. */
export async function openHeldRequest(
  server: { port?: number },
  db: Database,
  init: HeldRequestInit,
): Promise<HeldRequest> {
  const arrived = nextArrival(db);

  let raw = '';
  let closed!: () => void;
  const finished = new Promise<void>((resolve) => (closed = resolve));
  const sock = await Bun.connect({
    hostname: 'localhost',
    port: server.port!,
    socket: {
      data(_s, d) { raw += Buffer.from(d).toString(); },
      close() { closed(); },
      error() { closed(); },
      open() {},
    },
  });
  const extra = Object.entries(init.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  sock.write(
    `${init.method} ${init.path} HTTP/1.1\r\nHost: localhost:${server.port}\r\n${extra}` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(init.payload)}\r\nConnection: close\r\n\r\n`,
  );

  return {
    arrived,
    async finish() {
      sock.write(init.payload);
      await Promise.race([
        finished,
        new Promise((_, reject) => setTimeout(() => reject(new Error('held request: no response within 8 s')), 8000)),
      ]);
      sock.end();
      const [head, ...rest] = raw.split('\r\n\r\n');
      return { status: Number(head.split(' ')[1]), body: rest.join('\r\n\r\n') };
    },
  };
}
