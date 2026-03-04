import type { Database } from '../db/compat-sqlite.js';
import { getDashboardHtml } from './html.js';
import {
  apiSummary, apiPnl, apiBudgets, apiSavings, apiAlerts,
  apiTransactions, apiExportCsv, apiExportXlsx, apiExportPnlCsv, apiExportNetWorthCsv,
  apiLogs, apiChatHistory, apiChatSessions, apiChatSessionHistory,
  apiUpdateTransaction, apiDeleteTransaction,
  apiTraces, apiTraceStats,
  apiAccounts, apiNetWorth, apiNetWorthTrend, apiAccountTransactions, apiSpendingByInstitution,
  apiInteractions, apiInteractionDetail, apiRunInteractions,
  apiAnnotateInteraction, apiAnnotationStats,
} from './api.js';
import { exportSftJsonl, exportDpoJsonl, getTrainingStats } from '../training/export.js';
import { initChatSession, handleChatMessage } from './chat.js';
import {
  isAuthEnabled, enableAuth, disableAuth,
  createUser, listUsers, getUserCount, deactivateUser,
  verifyLogin, validateToken, revokeToken, cleanExpiredSessions,
  type DashboardUser,
} from './auth.js';
import {
  getActiveDb, switchProfile, getAvailableProfiles, getCurrentProfileName, setInitialProfile,
} from './db-manager.js';

const DEFAULT_PORT = 3141;

// ── RBAC ────────────────────────────────────────────────────────────────────

type Role = 'admin' | 'viewer';

function canWrite(role: Role): boolean {
  return role === 'admin';
}

function canManageUsers(role: Role): boolean {
  return role === 'admin';
}

// ── Server ──────────────────────────────────────────────────────────────────

/**
 * Start the dashboard HTTP server.
 * Supports optional auth/RBAC and multi-profile DB switching.
 */
export function startDashboardServer(db: Database, preferredPort?: number) {
  const port = preferredPort ?? DEFAULT_PORT;

  // Set up initial DB in manager and chat session
  setInitialProfile(getCurrentProfileName(), db);
  initChatSession(db);

  // Clean expired sessions on startup
  try { cleanExpiredSessions(db); } catch { /* table may not exist yet */ }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
      }

      try {
        // Get active DB (may change after profile switch)
        const activeDb = getActiveDb();

        // ── Auth middleware ──────────────────────────────────────────
        let currentUser: DashboardUser | null = null;
        const authEnabled = isAuthEnabled(activeDb);

        if (authEnabled) {
          // Extract token from header or query param
          const authHeader = req.headers.get('Authorization');
          const token = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7)
            : url.searchParams.get('token');

          if (token) {
            currentUser = validateToken(activeDb, token);
          }

          // Public auth routes (no token required)
          const publicPaths = ['/api/auth/status', '/api/auth/setup', '/api/auth/login'];
          const isPublicAuth = publicPaths.includes(path);
          const isHtmlPage = path === '/' || path === '/index.html';

          if (!isPublicAuth && !isHtmlPage && !currentUser) {
            return Response.json(
              { error: 'Unauthorized' },
              { status: 401, headers }
            );
          }
        }

        // ── HTML page ───────────────────────────────────────────────
        if (path === '/' || path === '/index.html') {
          return new Response(getDashboardHtml(port), {
            headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        // ── Auth API routes ─────────────────────────────────────────

        if (path === '/api/auth/status') {
          return Response.json({
            authEnabled,
            user: currentUser ? { id: currentUser.id, username: currentUser.username, role: currentUser.role } : null,
            userCount: getUserCount(activeDb),
          }, { headers });
        }

        if (path === '/api/auth/setup' && req.method === 'POST') {
          // Only allowed when 0 users exist
          if (getUserCount(activeDb) > 0) {
            return Response.json({ error: 'Admin already exists' }, { status: 400, headers });
          }
          const body = await req.json() as { username?: string; password?: string };
          if (!body.username || !body.password) {
            return Response.json({ error: 'username and password required' }, { status: 400, headers });
          }
          const user = await createUser(activeDb, body.username, body.password, 'admin');
          enableAuth(activeDb);
          const login = await verifyLogin(activeDb, body.username, body.password);
          return Response.json({ user, token: login?.token }, { headers });
        }

        if (path === '/api/auth/login' && req.method === 'POST') {
          const body = await req.json() as { username?: string; password?: string };
          if (!body.username || !body.password) {
            return Response.json({ error: 'username and password required' }, { status: 400, headers });
          }
          const result = await verifyLogin(activeDb, body.username, body.password);
          if (!result) {
            return Response.json({ error: 'Invalid credentials' }, { status: 401, headers });
          }
          return Response.json({ token: result.token, user: result.user }, { headers });
        }

        if (path === '/api/auth/logout' && req.method === 'POST') {
          const authHeader = req.headers.get('Authorization');
          const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
          if (token) revokeToken(activeDb, token);
          return Response.json({ success: true }, { headers });
        }

        if (path === '/api/auth/users' && req.method === 'GET') {
          if (authEnabled && (!currentUser || !canManageUsers(currentUser.role))) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          return Response.json(listUsers(activeDb), { headers });
        }

        if (path === '/api/auth/users' && req.method === 'POST') {
          if (authEnabled && (!currentUser || !canManageUsers(currentUser.role))) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as { username?: string; password?: string; role?: 'admin' | 'viewer' };
          if (!body.username || !body.password) {
            return Response.json({ error: 'username and password required' }, { status: 400, headers });
          }
          const user = await createUser(activeDb, body.username, body.password, body.role ?? 'viewer');
          return Response.json(user, { headers });
        }

        const userDeleteMatch = path.match(/^\/api\/auth\/users\/(\d+)$/);
        if (userDeleteMatch && req.method === 'DELETE') {
          if (authEnabled && (!currentUser || !canManageUsers(currentUser.role))) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const id = parseInt(userDeleteMatch[1], 10);
          const success = deactivateUser(activeDb, id);
          return Response.json({ success, id }, { headers });
        }

        if (path === '/api/auth/config' && req.method === 'PATCH') {
          if (authEnabled && (!currentUser || !canManageUsers(currentUser.role))) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as { auth_enabled?: boolean };
          if (body.auth_enabled === true) enableAuth(activeDb);
          else if (body.auth_enabled === false) disableAuth(activeDb);
          return Response.json({ auth_enabled: isAuthEnabled(activeDb) }, { headers });
        }

        // ── Profile API routes ──────────────────────────────────────

        if (path === '/api/profiles') {
          return Response.json({
            profiles: getAvailableProfiles(),
            active: getCurrentProfileName(),
          }, { headers });
        }

        if (path === '/api/profiles/switch' && req.method === 'POST') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as { name?: string };
          if (!body.name) {
            return Response.json({ error: 'name required' }, { status: 400, headers });
          }
          switchProfile(body.name);
          return Response.json({ active: getCurrentProfileName() }, { headers });
        }

        // ── Data API routes ─────────────────────────────────────────

        if (path === '/api/summary') {
          return Response.json(apiSummary(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/pnl') {
          return Response.json(apiPnl(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/budgets') {
          return Response.json(apiBudgets(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/savings') {
          return Response.json(apiSavings(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/alerts') {
          return Response.json(apiAlerts(activeDb), { headers });
        }
        if (path === '/api/transactions') {
          return Response.json(apiTransactions(activeDb, url.searchParams), { headers });
        }

        // Transaction edit/delete (RBAC: admin only)
        const txnMatch = path.match(/^\/api\/transactions\/(\d+)$/);
        if (txnMatch) {
          const id = parseInt(txnMatch[1], 10);
          if (req.method === 'PATCH') {
            if (authEnabled && currentUser && !canWrite(currentUser.role)) {
              return Response.json({ error: 'Forbidden' }, { status: 403, headers });
            }
            const body = await req.json() as Record<string, unknown>;
            return Response.json(apiUpdateTransaction(activeDb, id, body), { headers });
          }
          if (req.method === 'DELETE') {
            if (authEnabled && currentUser && !canWrite(currentUser.role)) {
              return Response.json({ error: 'Forbidden' }, { status: 403, headers });
            }
            return Response.json(apiDeleteTransaction(activeDb, id), { headers });
          }
        }

        // ── Accounts / Net Worth ────────────────────────────────────

        if (path === '/api/spending-by-institution') {
          return Response.json(apiSpendingByInstitution(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/accounts') {
          return Response.json(apiAccounts(activeDb), { headers });
        }
        if (path === '/api/net-worth') {
          return Response.json(apiNetWorth(activeDb), { headers });
        }
        if (path === '/api/net-worth/trend') {
          return Response.json(apiNetWorthTrend(activeDb, url.searchParams), { headers });
        }
        const acctTxnMatch = path.match(/^\/api\/accounts\/(\d+)\/transactions$/);
        if (acctTxnMatch) {
          const accountId = parseInt(acctTxnMatch[1], 10);
          return Response.json(apiAccountTransactions(activeDb, accountId, url.searchParams), { headers });
        }

        // ── Export ──────────────────────────────────────────────────

        if (path === '/api/export/csv') {
          const csv = apiExportCsv(activeDb, url.searchParams);
          return new Response(csv, {
            headers: {
              ...headers,
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="transactions.csv"',
            },
          });
        }
        if (path === '/api/export/xlsx') {
          try {
            const buf = apiExportXlsx(activeDb, url.searchParams);
            return new Response(new Uint8Array(buf), {
              headers: {
                ...headers,
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': 'attachment; filename="transactions.xlsx"',
              },
            });
          } catch {
            return Response.json(
              { error: 'XLSX export requires the xlsx package. Install with: bun add xlsx' },
              { status: 500, headers }
            );
          }
        }
        if (path === '/api/export/pnl') {
          const csv = apiExportPnlCsv(activeDb, url.searchParams);
          return new Response(csv, {
            headers: {
              ...headers,
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="pnl.csv"',
            },
          });
        }
        if (path === '/api/export/net-worth') {
          const csv = apiExportNetWorthCsv(activeDb);
          return new Response(csv, {
            headers: {
              ...headers,
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="net-worth.csv"',
            },
          });
        }

        // ── Logs & Traces ───────────────────────────────────────────

        if (path === '/api/logs') {
          return Response.json(apiLogs(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/traces') {
          return Response.json(apiTraces(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/traces/stats') {
          return Response.json(apiTraceStats(activeDb), { headers });
        }

        // ── Chat ────────────────────────────────────────────────────

        if (path === '/api/chat/history') {
          return Response.json(apiChatHistory(activeDb), { headers });
        }
        if (path === '/api/chat/sessions') {
          return Response.json(apiChatSessions(activeDb), { headers });
        }
        const sessionMatch = path.match(/^\/api\/chat\/sessions\/(.+)$/);
        if (sessionMatch) {
          return Response.json(apiChatSessionHistory(activeDb, sessionMatch[1]), { headers });
        }

        if (path === '/api/chat' && req.method === 'POST') {
          const body = await req.json() as { query?: string; sessionId?: string };
          if (!body.query) {
            return Response.json({ error: 'query is required' }, { status: 400, headers });
          }
          const result = await handleChatMessage(body.query, body.sessionId);
          return Response.json(result, { headers });
        }

        // ── Interactions (Training Data) ─────────────────────────────

        if (path === '/api/interactions') {
          return Response.json(apiInteractions(activeDb, url.searchParams), { headers });
        }

        const interactionMatch = path.match(/^\/api\/interactions\/(\d+)$/);
        if (interactionMatch) {
          const id = parseInt(interactionMatch[1], 10);
          if (req.method === 'GET') {
            const detail = apiInteractionDetail(activeDb, id);
            if (!detail) return Response.json({ error: 'Not found' }, { status: 404, headers });
            return Response.json(detail, { headers });
          }
        }

        const annotateMatch = path.match(/^\/api\/interactions\/(\d+)\/annotate$/);
        if (annotateMatch && req.method === 'POST') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const id = parseInt(annotateMatch[1], 10);
          const body = await req.json() as Record<string, unknown>;
          return Response.json(apiAnnotateInteraction(activeDb, id, body), { headers });
        }

        const runMatch = path.match(/^\/api\/runs\/(.+)$/);
        if (runMatch) {
          return Response.json(apiRunInteractions(activeDb, runMatch[1]), { headers });
        }

        if (path === '/api/annotations/stats') {
          return Response.json(apiAnnotationStats(activeDb), { headers });
        }

        // ── Training Export ──────────────────────────────────────────

        if (path === '/api/export/training/sft') {
          const minRating = parseInt(url.searchParams.get('minRating') ?? '4', 10);
          const callTypesParam = url.searchParams.get('callTypes');
          const callTypes = callTypesParam ? callTypesParam.split(',') : ['agent'];
          const model = url.searchParams.get('model') ?? undefined;
          const jsonl = exportSftJsonl(activeDb, { minRating, callTypes, model });
          return new Response(jsonl, {
            headers: {
              ...headers,
              'Content-Type': 'application/x-ndjson',
              'Content-Disposition': 'attachment; filename="wilson-sft.jsonl"',
            },
          });
        }

        if (path === '/api/export/training/dpo') {
          const jsonl = exportDpoJsonl(activeDb);
          return new Response(jsonl, {
            headers: {
              ...headers,
              'Content-Type': 'application/x-ndjson',
              'Content-Disposition': 'attachment; filename="wilson-dpo.jsonl"',
            },
          });
        }

        if (path === '/api/export/training/stats') {
          return Response.json(getTrainingStats(activeDb), { headers });
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
