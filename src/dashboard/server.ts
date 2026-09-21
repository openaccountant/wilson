import type { Database } from '../db/compat-sqlite.js';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { getDashboardHtml } from './html.js';
import {
  apiSummary, apiPnl, apiBudgets, apiSavings, apiCashflowMonthly, apiAlerts,
  apiTransactions, apiSemanticSearch, apiExportCsv, apiExportXlsx, apiExportPnlCsv, apiExportNetWorthCsv,
  apiLogs, apiChatHistory, apiChatSessions, apiChatSessionHistory,
  apiLocalChatConfig, apiRecordLocalChatMessage, apiModels, apiSetTaskModel,
  type SetTaskModelBody,
  apiDemoShowdownSamples, apiDemoShowdownCloud, apiDemoShowdownLocal, apiDemoShowdownBrowserTrace,
  apiUpdateTransaction, apiDeleteTransaction,
  apiTraces, apiTraceStats,
  apiAccounts, apiNetWorth, apiNetWorthTrend, apiAccountTransactions, apiSpendingByInstitution,
  apiInteractions, apiInteractionDetail, apiRunInteractions,
  apiAnnotateInteraction, apiAnnotationStats,
  apiDailySpending, apiStreak, apiWeeklySummary, apiBudgetCountdown,
  apiGoals, apiGoalSnapshots,
  apiMemories, apiAddMemory, apiDeactivateMemory,
  apiGetCustomPrompt, apiSetCustomPrompt,
  apiEntities, apiCreateEntity, apiUpdateEntity, apiDeleteEntity,
  apiImport, apiDemoTraceStep, type ImportRequestBody,
  apiReviewQueue, apiConfirmReview, apiCorrectReview,
} from './api.js';
import type { EmbedFn } from '../demo/statement-trace.js';
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
import { handleMcpRoute } from './mcp-routes.js';
import { handleMcpHttpRequest } from '../mcp/http-server.js';
import { revokeGrantsForUser } from '../mcp/store.js';

const DEFAULT_PORT = 3141;

/**
 * Paths whose own auth model replaces the dashboard bearer-token check:
 * `/mcp` authenticates each call with its own grant-bound bearer token
 * (see src/mcp/http-server.ts), not the dashboard_sessions token — an
 * external MCP client like Hronaut has no dashboard login of its own.
 */
const MCP_HTTP_PATH = '/mcp';

/**
 * `/api/mcp/*` and `/mcp` carry grant tokens and mutation approvals — never
 * safe to hand to `*`. A request with no Origin header (a non-browser HTTP
 * client, e.g. Hronaut hitting `/mcp` directly) isn't a CORS-relevant
 * request at all, so there's nothing to restrict; a browser request gets
 * reflected only when it already matches this server's own origin.
 */
function mcpCorsHeaders(port: number, requestOrigin: string | null): Record<string, string> {
  if (!requestOrigin) return {};
  const ownOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (ownOrigins.includes(requestOrigin)) {
    return { 'Access-Control-Allow-Origin': requestOrigin, Vary: 'Origin' };
  }
  return {};
}

/** Bundle webmcp-bridge.ts into browser-runnable JS once, at server startup. */
async function buildWebMcpBridgeScript(): Promise<string> {
  try {
    const result = await Bun.build({
      entrypoints: [new URL('./webmcp-bridge.ts', import.meta.url).pathname],
      target: 'browser',
      minify: false,
    });
    const output = result.outputs[0];
    return output ? await output.text() : '';
  } catch (err) {
    console.error('[webmcp-bridge] failed to build bridge script:', err);
    return '';
  }
}

/** Injects the WebMCP bridge <script> tag into either the React build or the legacy HTML. */
function injectWebMcpBridge(html: string, port: number): string {
  const tag = `<script src="/webmcp-bridge.js" data-port="${port}" defer></script>`;
  if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`);
  return html + tag;
}

// ── Static hybrid-chat assets ───────────────────────────────────────────────

/** Output of the hybrid vite build (`npm run build:hybrid` in src/dashboard/ui). */
export const DASHBOARD_ASSETS_DIR = new URL('./ui/dist-hybrid/', import.meta.url).pathname;

const ASSET_MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

/**
 * Serve a file from the hybrid build output under /assets/.
 *
 * These must be public (no auth): the hybrid chunk is loaded as a module
 * script and the onnxruntime-web binaries are fetched by ORT itself — neither
 * can attach an Authorization header. A 404 is the normal "hybrid not built"
 * state; the client treats a failed chunk load as capability-unavailable and
 * silently uses the server path.
 *
 * Rejects path traversal: the resolved path must stay inside `dir`.
 */
export async function serveDashboardAsset(
  pathname: string,
  dir: string,
  headers: Record<string, string>,
): Promise<Response> {
  const notFound = () => new Response('Not Found', { status: 404, headers });

  const rel = pathname.slice('/assets/'.length);
  if (!rel || rel.includes('\0')) return notFound();

  const root = resolvePath(dir);
  const resolved = resolvePath(root, rel);
  if (resolved !== root && !resolved.startsWith(root + pathSep)) return notFound();

  const file = Bun.file(resolved);
  if (!(await file.exists())) return notFound();

  const ext = resolved.slice(resolved.lastIndexOf('.'));
  const contentType = ASSET_MIME_TYPES[ext] ?? 'application/octet-stream';
  return new Response(file, { headers: { ...headers, 'Content-Type': contentType } });
}

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
export interface DashboardServerOptions {
  /**
   * Injectable embed function for the Demo tab's statement trace chain
   * (tests inject a deterministic fake embedder so no model download happens).
   * Production default is the local embedTexts engine.
   */
  traceEmbed?: EmbedFn;
}

export async function startDashboardServer(db: Database, preferredPort?: number, options?: DashboardServerOptions) {
  const traceEmbed = options?.traceEmbed;
  const port = preferredPort ?? DEFAULT_PORT;

  // Load the React dashboard build (single-file HTML), with fallback to legacy html.ts
  let reactDashboardHtml: string | null = null;
  try {
    reactDashboardHtml = await Bun.file(
      new URL('./ui/dist/index.html', import.meta.url)
    ).text();
  } catch {
    // React build not available — fall back to legacy getDashboardHtml()
  }

  // Bundle the WebMCP bridge once at startup — deliberately independent of
  // the React dashboard build so the bridge works whether or not `ui/dist`
  // exists. Injected into whichever HTML the page route returns below.
  const webMcpBridgeScript = await buildWebMcpBridgeScript();

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

      // `port` may be 0 (ephemeral, e.g. in tests) — server.port is the actual
      // bound port once Bun.serve has returned, which is what a real request's
      // Origin header will contain. `server` is safe to reference here even
      // though it's declared by this same Bun.serve(...) call: fetch only
      // ever runs after that assignment has completed.
      const actualPort = server.port ?? port;

      const isMcpPath = path === MCP_HTTP_PATH || path.startsWith('/api/mcp');
      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
      };
      if (isMcpPath) {
        // Never the wildcard for grant/approval/mutation traffic — see mcpCorsHeaders.
        delete headers['Access-Control-Allow-Origin'];
        Object.assign(headers, mcpCorsHeaders(actualPort, req.headers.get('Origin')));
      }

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
      }

      try {
        // Get active DB (may change after profile switch)
        const activeDb = getActiveDb();

        // ── Static hybrid-chat assets (public) ────────────────────────
        // Module scripts and ORT's own wasm fetches cannot send auth headers,
        // so /assets/* is served without the auth middleware (same treatment
        // as the HTML page). Contents are build artifacts only.
        if (path.startsWith('/assets/')) {
          return serveDashboardAsset(path, DASHBOARD_ASSETS_DIR, headers);
        }

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
          const isHtmlPage = path === '/' || path === '/index.html' || path === '/webmcp-bridge.js';
          // /mcp authenticates each call with its own grant-bound bearer token
          // (see src/mcp/http-server.ts) — an external MCP client has no
          // dashboard login to present here.
          const isMcpHttp = path === MCP_HTTP_PATH;

          if (!isPublicAuth && !isHtmlPage && !isMcpHttp && !currentUser) {
            return Response.json(
              { error: 'Unauthorized' },
              { status: 401, headers }
            );
          }
        }

        // ── WebMCP bridge (Streamable-HTTP fallback + browser-facing API) ──

        if (path === MCP_HTTP_PATH) {
          return handleMcpHttpRequest(activeDb, req);
        }

        if (path.startsWith('/api/mcp/')) {
          const mcpResponse = await handleMcpRoute(req, url, path, {
            activeDb,
            currentUser,
            authEnabled,
            port: actualPort,
            headers,
          });
          if (mcpResponse) return mcpResponse;
        }

        // ── HTML page ───────────────────────────────────────────────
        if (path === '/' || path === '/index.html') {
          const html = injectWebMcpBridge(reactDashboardHtml ?? getDashboardHtml(port), port);
          return new Response(html, {
            headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        if (path === '/webmcp-bridge.js') {
          return new Response(webMcpBridgeScript, {
            headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
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
          if (token) {
            revokeToken(activeDb, token);
            // A dashboard logout ends the browser's WebMCP grants too — a
            // stolen/replayed session token shouldn't be able to keep using
            // tool access minted under the now-dead login.
            if (currentUser) revokeGrantsForUser(activeDb, currentUser.id);
          }
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
        if (path === '/api/cashflow/monthly') {
          return Response.json(apiCashflowMonthly(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/alerts') {
          return Response.json(apiAlerts(activeDb), { headers });
        }
        if (path === '/api/daily-spending') {
          return Response.json(apiDailySpending(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/streak') {
          return Response.json(apiStreak(activeDb), { headers });
        }
        if (path === '/api/weekly-summary') {
          return Response.json(apiWeeklySummary(activeDb), { headers });
        }
        if (path === '/api/budget-countdown') {
          return Response.json(apiBudgetCountdown(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/transactions') {
          return Response.json(apiTransactions(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/transactions/search') {
          return Response.json(await apiSemanticSearch(activeDb, url.searchParams), { headers });
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
            return Response.json(await apiUpdateTransaction(activeDb, id, body), { headers });
          }
          if (req.method === 'DELETE') {
            if (authEnabled && currentUser && !canWrite(currentUser.role)) {
              return Response.json({ error: 'Forbidden' }, { status: 403, headers });
            }
            return Response.json(apiDeleteTransaction(activeDb, id), { headers });
          }
        }

        // ── Categorization review queue ─────────────────────────────
        // Reads are open to any authenticated user (viewers see the queue
        // read-only); mutations follow the standard admin-only canWrite guard.

        if (path === '/api/reviews') {
          return Response.json(apiReviewQueue(activeDb, url.searchParams), { headers });
        }

        const reviewMatch = path.match(/^\/api\/reviews\/(\d+)\/(confirm|correct)$/);
        if (reviewMatch && req.method === 'POST') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const id = parseInt(reviewMatch[1], 10);
          const result = reviewMatch[2] === 'confirm'
            ? apiConfirmReview(activeDb, id)
            : apiCorrectReview(activeDb, id, await req.json() as { category?: string });
          return Response.json(result, { status: result.success ? 200 : result.status, headers });
        }

        // ── Goals ──────────────────────────────────────────────────

        if (path === '/api/goals') {
          return Response.json(apiGoals(activeDb), { headers });
        }
        const goalSnapshotMatch = path.match(/^\/api\/goals\/(\d+)\/snapshots$/);
        if (goalSnapshotMatch) {
          const goalId = parseInt(goalSnapshotMatch[1], 10);
          return Response.json(apiGoalSnapshots(activeDb, goalId, url.searchParams), { headers });
        }

        // ── Entities ─────────────────────────────────────────────────

        if (path === '/api/entities' && req.method === 'GET') {
          return Response.json(apiEntities(activeDb), { headers });
        }
        if (path === '/api/entities' && req.method === 'POST') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as Record<string, unknown>;
          return Response.json(apiCreateEntity(activeDb, body as { name?: string; description?: string; color?: string }), { headers });
        }
        const entityMatch = path.match(/^\/api\/entities\/(\d+)$/);
        if (entityMatch) {
          const id = parseInt(entityMatch[1], 10);
          if (req.method === 'PUT') {
            if (authEnabled && currentUser && !canWrite(currentUser.role)) {
              return Response.json({ error: 'Forbidden' }, { status: 403, headers });
            }
            const body = await req.json() as Record<string, unknown>;
            return Response.json(apiUpdateEntity(activeDb, id, body as { name?: string; description?: string; color?: string }), { headers });
          }
          if (req.method === 'DELETE') {
            if (authEnabled && currentUser && !canWrite(currentUser.role)) {
              return Response.json({ error: 'Forbidden' }, { status: 403, headers });
            }
            return Response.json(apiDeleteEntity(activeDb, id), { headers });
          }
        }

        // ── Import ──────────────────────────────────────────────────

        if (path === '/api/import' && req.method === 'POST') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as ImportRequestBody;
          const result = await apiImport(activeDb, body);
          return Response.json(result, { status: result.status === 'failed' ? 400 : 200, headers });
        }

        // ── Demo: statement agent trace ─────────────────────────────
        // One endpoint for all four chain steps; `import` is the only write
        // and mirrors /api/import's canWrite RBAC exactly.

        if (path === '/api/demo/trace/step' && req.method === 'POST') {
          const body = await req.json() as { step?: unknown };
          if (body?.step === 'import' && authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const result = await apiDemoTraceStep(activeDb, body, traceEmbed ? { embed: traceEmbed } : undefined);
          return Response.json(result, { status: result.status === 'error' ? 400 : 200, headers });
        }

        // ── Memories ─────────────────────────────────────────────────

        if (path === '/api/memories' && req.method === 'GET') {
          return Response.json(apiMemories(activeDb), { headers });
        }
        if (path === '/api/memories' && req.method === 'POST') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as Record<string, unknown>;
          return Response.json(apiAddMemory(activeDb, body as { memoryType?: string; content?: string; category?: string }), { headers });
        }
        const memoryDeleteMatch = path.match(/^\/api\/memories\/(\d+)$/);
        if (memoryDeleteMatch && req.method === 'DELETE') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const id = parseInt(memoryDeleteMatch[1], 10);
          return Response.json(apiDeactivateMemory(activeDb, id), { headers });
        }

        // ── Settings ────────────────────────────────────────────────

        if (path === '/api/settings/custom-prompt' && req.method === 'GET') {
          return Response.json(apiGetCustomPrompt(activeDb), { headers });
        }
        if (path === '/api/settings/custom-prompt' && req.method === 'PUT') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as { prompt?: string };
          return Response.json(apiSetCustomPrompt(activeDb, body), { headers });
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

        // ── Hybrid (local-first WebGPU) chat ────────────────────────

        if (path === '/api/config/local-chat') {
          return Response.json(apiLocalChatConfig(), { headers });
        }

        // ── Models panel (Settings) ─────────────────────────────────

        if (path === '/api/models' && req.method === 'POST') {
          // Same posture as every other settings write: admin-only when auth
          // is on, allowed in single-user local mode (auth disabled).
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as SetTaskModelBody;
          const result = apiSetTaskModel(body);
          if ('error' in result) {
            return Response.json(result, { status: 400, headers });
          }
          return Response.json(result, { headers });
        }

        if (path === '/api/models') {
          return Response.json(await apiModels(), { headers });
        }

        if (path === '/api/chat/local' && req.method === 'POST') {
          const body = await req.json() as { query?: string; answer?: string; sessionId?: string };
          const result = apiRecordLocalChatMessage(activeDb, body);
          if ('error' in result) {
            return Response.json(result, { status: 400, headers });
          }
          return Response.json(result, { headers });
        }

        // ── Demo: Speed Showdown (issue #92) ────────────────────────

        if (path === '/api/demo/showdown/samples') {
          return Response.json(apiDemoShowdownSamples(), { headers });
        }

        if (path === '/api/demo/showdown/cloud' && req.method === 'POST') {
          const body = await req.json() as Record<string, unknown>;
          try {
            const result = await apiDemoShowdownCloud(body);
            return Response.json(result, { headers });
          } catch (err) {
            // Bad input only (missing/unknown slug). Arm failures resolve
            // above as { ok:false, error } with HTTP 200 so the demo degrades
            // inline instead of showing a broken panel.
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400, headers },
            );
          }
        }

        if (path === '/api/demo/showdown/local' && req.method === 'POST') {
          const body = await req.json() as Record<string, unknown>;
          try {
            const result = await apiDemoShowdownLocal(body);
            return Response.json(result, { headers });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400, headers },
            );
          }
        }

        if (path === '/api/demo/showdown/browser-trace' && req.method === 'POST') {
          const body = await req.json() as Record<string, unknown>;
          try {
            const result = apiDemoShowdownBrowserTrace(body);
            return Response.json(result, { headers });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400, headers },
            );
          }
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
