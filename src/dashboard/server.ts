import type { Database } from '../db/compat-sqlite.js';
import { getDashboardHtml } from './html.js';
import { apiSummary, apiPnl, apiBudgets, apiSavings, apiAlerts, apiTransactions } from './api.js';
import { initChatSession, handleChatMessage } from './chat.js';

const DEFAULT_PORT = 3141;

/**
 * Start the dashboard HTTP server using Bun.serve.
 * Returns the server instance and the URL it's listening on.
 */
export function startDashboardServer(db: Database, preferredPort?: number) {
  const port = preferredPort ?? DEFAULT_PORT;

  // Initialize chat session with the live DB
  initChatSession(db);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS headers for local development
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
      }

      try {
        // HTML dashboard page
        if (path === '/' || path === '/index.html') {
          return new Response(getDashboardHtml(port), {
            headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        // JSON API routes
        if (path === '/api/summary') {
          return Response.json(apiSummary(db, url.searchParams), { headers });
        }
        if (path === '/api/pnl') {
          return Response.json(apiPnl(db, url.searchParams), { headers });
        }
        if (path === '/api/budgets') {
          return Response.json(apiBudgets(db, url.searchParams), { headers });
        }
        if (path === '/api/savings') {
          return Response.json(apiSavings(db, url.searchParams), { headers });
        }
        if (path === '/api/alerts') {
          return Response.json(apiAlerts(db), { headers });
        }
        if (path === '/api/transactions') {
          return Response.json(apiTransactions(db, url.searchParams), { headers });
        }

        // Chat endpoint
        if (path === '/api/chat' && req.method === 'POST') {
          const body = await req.json() as { query?: string };
          if (!body.query) {
            return Response.json({ error: 'query is required' }, { status: 400, headers });
          }
          const answer = await handleChatMessage(body.query);
          return Response.json({ answer }, { headers });
        }

        return new Response('Not Found', { status: 404, headers });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500, headers }
        );
      }
    },
  });

  return { server, url: `http://localhost:${port}` };
}

/**
 * Stop the dashboard server.
 */
export function stopDashboardServer(server: ReturnType<typeof Bun.serve>): void {
  server.stop();
}
