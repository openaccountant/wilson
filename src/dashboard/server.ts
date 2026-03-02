import type { Database } from '../db/compat-sqlite.js';
import { getDashboardHtml } from './html.js';
import { apiSummary, apiPnl, apiBudgets, apiSavings, apiAlerts, apiTransactions, apiExportCsv, apiLogs, apiChatHistory, apiChatSessions, apiChatSessionHistory, apiUpdateTransaction, apiDeleteTransaction, apiTraces, apiTraceStats } from './api.js';
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
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
        if (path === '/api/export/csv') {
          const csv = apiExportCsv(db, url.searchParams);
          return new Response(csv, {
            headers: {
              ...headers,
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="transactions.csv"',
            },
          });
        }
        if (path === '/api/logs') {
          return Response.json(apiLogs(url.searchParams), { headers });
        }
        if (path === '/api/traces') {
          return Response.json(apiTraces(url.searchParams), { headers });
        }
        if (path === '/api/traces/stats') {
          return Response.json(apiTraceStats(), { headers });
        }

        // Transaction edit/delete endpoints
        const txnMatch = path.match(/^\/api\/transactions\/(\d+)$/);
        if (txnMatch) {
          const id = parseInt(txnMatch[1], 10);
          if (req.method === 'PATCH') {
            const body = await req.json() as Record<string, unknown>;
            return Response.json(apiUpdateTransaction(db, id, body), { headers });
          }
          if (req.method === 'DELETE') {
            return Response.json(apiDeleteTransaction(db, id), { headers });
          }
        }

        // Chat history endpoints
        if (path === '/api/chat/history') {
          return Response.json(apiChatHistory(db), { headers });
        }
        if (path === '/api/chat/sessions') {
          return Response.json(apiChatSessions(db), { headers });
        }
        const sessionMatch = path.match(/^\/api\/chat\/sessions\/(.+)$/);
        if (sessionMatch) {
          return Response.json(apiChatSessionHistory(db, sessionMatch[1]), { headers });
        }

        // Chat endpoint
        if (path === '/api/chat' && req.method === 'POST') {
          const body = await req.json() as { query?: string; sessionId?: string };
          if (!body.query) {
            return Response.json({ error: 'query is required' }, { status: 400, headers });
          }
          const answer = await handleChatMessage(body.query, body.sessionId);
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
