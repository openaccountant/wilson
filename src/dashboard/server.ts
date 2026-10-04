import type { Database } from '../db/compat-sqlite.js';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { getDashboardHtml } from './html.js';
import {
  apiSummary, apiPnl, apiBudgets, apiCoverage, apiBudgetLimits, apiCategories, apiCategoryOptions, apiSpendingBreakdown, apiSpendingSeries, apiSavings, apiCashflowMonthly, apiAlerts,
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
  apiReviewQueue, apiConfirmReview, apiCorrectReview, apiSetBudget, apiUpdateGoal,
  apiDemoPrivacyStart, apiDemoPrivacyLedger, apiDemoPrivacyExhibit,
  apiSkills, apiMerchants,
} from './api.js';
import { validateMentions, resolveMentionContext } from './mentions.js';
import { isBadRequest } from './spending-params.js';
import { buildHandoffContext, serverReadExecutor } from './local-handoff.js';
import { apiDemoAutoBookCandidates } from '../demo/auto-book.js';
import type { EmbedFn } from '../demo/statement-trace.js';
import { exportSftJsonl, exportDpoJsonl, getTrainingStats, exportProvenance, type ExportQualifyOptions } from '../training/export.js';
import { annotateAgentPresent, handleJudgementRoute } from './judgement-routes.js';
import { buildScheduleC, scheduleCToCsv, scheduleCToXlsxBuffer } from '../tools/tax/schedule-c.js';
import { hasLicense } from '../licensing/license.js';
import { getCheckoutUrl } from '../licensing/upsell.js';
import { initChatSession, handleChatMessage, getCategorizeProgress } from './chat.js';
import {
  isAuthEnabled, enableAuth, disableAuth, lanAuthReady,
  listUsers, getUserCount, deactivateUser, hashPassword, insertUser, createFirstAdmin,
  verifyLogin, validateToken, revokeToken, cleanExpiredSessions, canWrite,
  type DashboardUser,
} from './auth.js';
import {
  getActiveDb, getOpenDbs, switchProfile, peekProfileDb, getAvailableProfiles, getCurrentProfileName, setInitialProfile,
} from './db-manager.js';
import {
  checkHost, checkStateChange, corsHeaders, isAllowedOrigin, isLoopbackBind, isLoopbackPeer, requireBrowserProof,
} from './origin-gate.js';
import { getGlobalAgentState } from '../mcp/global-state.js';
import { handleMcpRoute } from './mcp-routes.js';
import { handleSyncRoute, syncCorsHeaders } from './sync-routes.js';
import { handleMcpHttpRequest } from '../mcp/http-server.js';
import { isAgentPresent, revokeGrantsForUser } from '../mcp/store.js';
import { runMcpMaintenance, runMcpMaintenanceAll, MAINTENANCE_INTERVAL_MS } from '../mcp/maintenance.js';
import { appendRestExportAudit, appendRestWriteAudit } from '../mcp/audit.js';
import { handlePrelabelRoute } from '../prelabel/routes.js';

const DEFAULT_PORT = 3141;

/** The 6-hourly MCP housekeeping timer for each running server, so stopDashboardServer can clear it. */
const maintenanceTimers = new WeakMap<object, ReturnType<typeof setInterval>>();

/**
 * Paths whose own auth model replaces the dashboard bearer-token check:
 * `/mcp` authenticates each call with its own grant-bound bearer token
 * (see src/mcp/http-server.ts), not the dashboard_sessions token — an
 * external MCP client like Hronaut has no dashboard login of its own.
 */
const MCP_HTTP_PATH = '/mcp';

/**
 * Bun's idle timeout is per connection and its maximum is 255 s. A `/mcp` tool
 * call that waits for a human to approve a card holds its connection open for up
 * to 240 s (see MUTATION_APPROVAL_WAIT_MS in src/mcp/http-server.ts), so the
 * default 10 s would cut it off.
 */
export const DASHBOARD_IDLE_TIMEOUT_S = 255;

const LOOPBACK_DEFAULT = '127.0.0.1';

/** `WILSON_DASHBOARD_HOST`, else `dashboardHost` in agent-access.json, else loopback. Read once at startup. */
function resolveBindHost(): string {
  return process.env.WILSON_DASHBOARD_HOST?.trim() || getGlobalAgentState().dashboardHost || LOOPBACK_DEFAULT;
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

// Profile names become path segments (see resolveProfile in profile/context.ts),
// so the HTTP API validates them — unlike the CLI's --profile flag, this accepts
// arbitrary input over the network and must not allow "../" traversal.
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ── RBAC ────────────────────────────────────────────────────────────────────

type Role = 'admin' | 'viewer';

function canManageUsers(role: Role): boolean {
  return role === 'admin';
}

/**
 * A hostile page must not be able to frame the dashboard: a framed page is same-origin
 * with itself, so it would pass the browser-proof gate and could show the user's approval
 * cards and kill-switch controls under an attacker's overlay (clickjacking). Sent on every
 * response, API and static assets included.
 */
export const ANTI_FRAMING_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

function withAntiFraming(res: Response): Response {
  try {
    for (const [k, v] of Object.entries(ANTI_FRAMING_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    // Immutable headers (a proxied or already-sent response): rebuild around the same body.
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(ANTI_FRAMING_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
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
  /**
   * Bind address. Defaults to `WILSON_DASHBOARD_HOST`, then `dashboardHost` in
   * `~/.openaccountant/agent-access.json`, then 127.0.0.1. A non-loopback bind
   * is the "LAN mode": it refuses to start, and answers 503, while the active
   * profile has dashboard auth off.
   */
  hostname?: string;
}

/** A request's JSON body, or `null` when it is missing or malformed (the route's schema then answers 400). */
async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Each of these is a separate, explicit per-export opt-in; anything but the literal "true" is off. */
function trainingExportFlags(url: URL): ExportQualifyOptions {
  return {
    includeJudge: url.searchParams.get('includeJudge') === 'true',
    includeAgentPresent: url.searchParams.get('includeAgentPresent') === 'true',
    includeHandoff: url.searchParams.get('includeHandoff') === 'true',
  };
}

export async function startDashboardServer(db: Database, preferredPort?: number, options?: DashboardServerOptions) {
  const traceEmbed = options?.traceEmbed;
  const port = preferredPort ?? DEFAULT_PORT;

  // The bind address is read once, here: a profile switch cannot change it.
  const hostname = options?.hostname ?? resolveBindHost();
  const lanMode = !isLoopbackBind(hostname);
  if (lanMode && !lanAuthReady(db)) {
    throw new Error(
      `Refusing to bind the dashboard to ${hostname} until dashboard auth is on AND an active admin user exists for this profile. ` +
      'Start on 127.0.0.1, create the admin account (the dashboard asks on first visit) and enable auth, then bind to the network. ' +
      'Turning auth on with no users is not enough: the first caller of /api/auth/setup would become admin.'
    );
  }

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

  // WebMCP housekeeping (expired grants, tokens, old operations, audit retention) at startup and every 6 h.
  runMcpMaintenance(db);

  const handleRequest = async (req: Request, bunServer: { requestIP(req: Request): { address: string } | null; timeout(req: Request, seconds: number): void }): Promise<Response> => {
      // `port` may be 0 (ephemeral, e.g. in tests) — server.port is the actual
      // bound port once Bun.serve has returned, which is what a real request's
      // Origin header will contain. `server` is safe to reference here even
      // though it's declared by this same Bun.serve(...) call: fetch only
      // ever runs after that assignment has completed.
      const actualPort = server.port ?? port;

      // DNS rebinding: only our own loopback names (or an allowlisted Host) may address this server.
      // Applies to every path, the HTML page and the bridge script included.
      // This runs before the URL is parsed: a malformed Host makes `req.url` unparseable.
      const hostDenied = checkHost(req, actualPort);
      if (hostDenied) return hostDenied;

      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return new Response(null, { status: 400 });
      }
      const path = url.pathname;

      // CORS reflects an allowlisted Origin and nothing else. There is no wildcard.
      const requestOrigin = req.headers.get('Origin');
      const headers: Record<string, string> = {
        // The reflected origin differs per request, so a cache must key on it.
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Wilson-Agent-Session',
        ...corsHeaders(actualPort, requestOrigin),
      };
      if (path.startsWith('/api/sync/')) {
        // Raw ledger rows for the mirror: never the wildcard (see sync-routes.ts).
        for (const k of Object.keys(headers)) delete headers[k];
        Object.assign(headers, syncCorsHeaders(actualPort, req.headers.get('Origin')));
      }

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
      }

      // `/mcp` authenticates with a client token, so the state-change rule below does not apply
      // to it, but a browser page from another origin must not be able to reach it either.
      if (path === MCP_HTTP_PATH && requestOrigin !== null && !isAllowedOrigin(requestOrigin, actualPort)) {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' }, id: null },
          { status: 403, headers }
        );
      }

      const stateDenied = checkStateChange(req, path, actualPort);
      if (stateDenied) {
        for (const [k, v] of Object.entries(headers)) stateDenied.headers.set(k, v);
        return stateDenied;
      }

      try {
        // Get active DB (may change after profile switch)
        const activeDb = getActiveDb();

        // LAN rule, checked on EVERY request: auth is per profile, so a switch (or an admin turning
        // auth off) can leave the served profile open while the socket is reachable from the network.
        if (lanMode && !lanAuthReady(activeDb)) {
          return Response.json(
            { error: { code: 'lan_auth_required', message: 'This profile needs dashboard auth enabled and an active admin user before it can be used over the network.' } },
            { status: 503, headers }
          );
        }

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
          // The bearer comes from the Authorization header. A `?token=` query token is accepted
          // only for GET /api/export/* downloads (an <a href> cannot send a header); anywhere else
          // it would put a credential in logs and Referer headers for no reason.
          const authHeader = req.headers.get('Authorization');
          const isExportDownload = req.method === 'GET' && path.startsWith('/api/export/');
          const token = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7)
            : isExportDownload ? url.searchParams.get('token') : null;

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

        // `authEnabled` is what the middleware saw when this request arrived.
        // A route that awaits its body (or a password hash) before writing
        // can find auth turned on by another request in between; one that
        // got past the middleware with no login must then be refused.
        const authTurnedOnMidRequest = () => !authEnabled && isAuthEnabled(activeDb);
        const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401, headers });

        // Export downloads are the one REST read path the audit log covers.
        // Every request that reaches an export route is audited whatever its
        // method, and only GET is served: a POST used to return the ledger
        // with no audit row.
        if (path.startsWith('/api/export/')) {
          try {
            const exportUserId = authEnabled && currentUser ? currentUser.id : null;
            // A training export says what it may contain (human, judge, agent-present, handoff) and whether an agent had
            // live access, so a download with opt-ins never looks like a default one in the log.
            const detail = path.startsWith('/api/export/training/')
              ? `provenance=${exportProvenance(trainingExportFlags(url))} agent_present=${isAgentPresent(activeDb, exportUserId, getCurrentProfileName())}`
              : undefined;
            appendRestExportAudit(activeDb, {
              route: path,
              userId: exportUserId,
              role: authEnabled && currentUser ? currentUser.role : 'admin',
              origin: req.headers.get('Origin') ?? 'direct',
              detail,
            });
          } catch (err) {
            console.error('[mcp-audit] failed to audit export:', err);
          }
          if (req.method !== 'GET') {
            return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
          }
        }

        // ── WebMCP bridge (Streamable-HTTP fallback + browser-facing API) ──

        if (path === MCP_HTTP_PATH) {
          return handleMcpHttpRequest(activeDb, req, bunServer.requestIP(req)?.address, getCurrentProfileName(), {
            setIdleTimeout: (seconds) => bunServer.timeout(req, seconds),
          });
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

        // Raw rows for the offline mirror's v4 sync (behind the auth gate above).
        const syncResponse = handleSyncRoute(req, path, { activeDb, headers, port: actualPort });
        if (syncResponse) return syncResponse;

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
          // Only allowed when 0 users exist, and in LAN mode only from this machine
          // (defense in depth: the LAN rule above already refuses a profile with no admin).
          if (lanMode && !isLoopbackPeer(bunServer.requestIP(req)?.address)) {
            return Response.json({ error: 'First-admin setup is only allowed from this machine while the dashboard is on the network.' }, { status: 403, headers });
          }
          if (getUserCount(activeDb) > 0) {
            return Response.json({ error: 'Admin already exists' }, { status: 400, headers });
          }
          const body = await req.json() as { username?: string; password?: string };
          if (!body.username || !body.password) {
            return Response.json({ error: 'username and password required' }, { status: 400, headers });
          }
          // Decide at write time: another setup may have created the admin
          // while this one awaited its body or the hash.
          const user = createFirstAdmin(activeDb, body.username, await hashPassword(body.password));
          if (!user) {
            return Response.json({ error: 'Admin already exists' }, { status: 400, headers });
          }
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
          const passwordHash = await hashPassword(body.password);
          if (authTurnedOnMidRequest()) return unauthorized();
          const user = insertUser(activeDb, body.username, passwordHash, body.role ?? 'viewer');
          return Response.json(user, { headers });
        }

        const userDeleteMatch = path.match(/^\/api\/auth\/users\/(\d+)$/);
        if (userDeleteMatch && req.method === 'DELETE') {
          if (authEnabled && (!currentUser || !canManageUsers(currentUser.role))) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const id = parseInt(userDeleteMatch[1], 10);
          const success = deactivateUser(activeDb, id);
          // A deactivated user's WebMCP grants die with the account, not at the grant's TTL.
          if (success) revokeGrantsForUser(activeDb, id);
          return Response.json({ success, id }, { headers });
        }

        if (path === '/api/auth/config' && req.method === 'PATCH') {
          if (authEnabled && (!currentUser || !canManageUsers(currentUser.role))) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await req.json() as { auth_enabled?: boolean };
          if (authTurnedOnMidRequest()) return unauthorized();
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
          if (!PROFILE_NAME_RE.test(body.name)) {
            return Response.json(
              { error: 'name must be 1-64 characters of letters, numbers, "-" or "_"' },
              { status: 400, headers },
            );
          }
          // In LAN mode a switch must not expose a profile that has no dashboard auth.
          if (lanMode) {
            const target = peekProfileDb(body.name);
            if (!target || !lanAuthReady(target)) {
              return Response.json(
                { error: 'That profile has no dashboard auth and admin user; set them up before switching while the dashboard is on the network.' },
                { status: 409, headers }
              );
            }
          }
          switchProfile(body.name);
          return Response.json({ active: getCurrentProfileName() }, { headers });
        }

        // A human REST write that an agent could also drive through the page (budget, goal, review confirm and
        // correct) leaves a `transport='rest'` audit row saying whether an agent had live access at the time,
        // computed here from server state. A failed write changed nothing and is not recorded.
        const auditRestWrite = (route: string, success: boolean, agentPresentOverride?: boolean): void => {
          if (!success) return;
          try {
            const userId = authEnabled && currentUser ? currentUser.id : null;
            appendRestWriteAudit(activeDb, {
              route,
              userId,
              role: authEnabled && currentUser ? currentUser.role : 'admin',
              origin: req.headers.get('Origin') ?? 'direct',
              agentPresent: agentPresentOverride ?? isAgentPresent(activeDb, userId, getCurrentProfileName()),
            });
          } catch (err) {
            console.error('[mcp-audit] failed to audit a REST write:', err);
          }
        };

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
        if (path === '/api/coverage') {
          return Response.json(apiCoverage(activeDb), { headers });
        }
        // Set one category's monthly limit (admin only). The Goals tab's budget form; an agent reaches the same
        // change through the `set_budget` tool and its confirmation card.
        const budgetPutMatch = path.match(/^\/api\/budgets\/([^/]+)$/);
        if (budgetPutMatch && budgetPutMatch[1] !== 'limits' && req.method === 'PUT') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          let category: string;
          try {
            category = decodeURIComponent(budgetPutMatch[1]);
          } catch {
            return Response.json({ error: 'malformed category' }, { status: 400, headers });
          }
          const result = apiSetBudget(activeDb, category, await readJsonBody(req));
          auditRestWrite('/api/budgets/:category', result.success);
          return Response.json(result, { status: result.success ? 200 : result.status, headers });
        }
        if (path === '/api/budgets/limits') {
          // Raw budget rows (sync feed for the offline mirror) — distinct from
          // /api/budgets, the vs-actual aggregation. Exact-match check, so the
          // two routes never collide.
          return Response.json(apiBudgetLimits(activeDb), { headers });
        }
        if (path === '/api/categories') {
          // Raw category rows (sync feed for the offline mirror).
          return Response.json(apiCategories(activeDb), { headers });
        }
        if (path === '/api/category-options') {
          // Header category filter options (every label in transactions).
          return Response.json(apiCategoryOptions(activeDb), { headers });
        }
        if (path === '/api/spending/breakdown' || path === '/api/spending/series') {
          // Spending drill (mirrored). A bad param is a 400 { error }, never a 500.
          const result = path === '/api/spending/breakdown'
            ? await apiSpendingBreakdown(activeDb, url.searchParams)
            : await apiSpendingSeries(activeDb, url.searchParams);
          if (isBadRequest(result)) {
            return Response.json({ error: result.error }, { status: 400, headers });
          }
          return Response.json(result, { headers });
        }
        if (path === '/api/skills') {
          // Chat "/" menu source. Name/description/tier/source only — never the SKILL.md path.
          return Response.json(apiSkills(), { headers });
        }
        if (path === '/api/merchants') {
          // Chat "@" menu source: distinct merchants with txn counts (read-only aggregate).
          return Response.json(
            apiMerchants(activeDb, url.searchParams.get('q'), url.searchParams.get('limit')),
            { headers },
          );
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
          return Response.json(apiStreak(activeDb, url.searchParams), { headers });
        }
        if (path === '/api/weekly-summary') {
          return Response.json(apiWeeklySummary(activeDb, url.searchParams), { headers });
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
          auditRestWrite(`/api/reviews/:id/${reviewMatch[2]}`, result.success);
          return Response.json(result, { status: result.success ? 200 : result.status, headers });
        }

        // ── open-jev pre-labeler (own origin gate, specs/open-jev-labeler.md §9.0) ──
        const pre = await handlePrelabelRoute(req, url, { db: activeDb, headers, authEnabled, currentUser, canWrite, port: actualPort, profile: getCurrentProfileName(), peerAddress: server.requestIP(req)?.address }); if (pre) return pre;

        // ── Goals ──────────────────────────────────────────────────

        if (path === '/api/goals') {
          return Response.json(apiGoals(activeDb, url.searchParams), { headers });
        }
        // Edit a goal's target amount, date or status (admin only). The Goals tab's edit form; an agent reaches
        // the same change through the `update_goal` tool and its confirmation card, never through this route.
        const goalPatchMatch = path.match(/^\/api\/goals\/(\d+)$/);
        if (goalPatchMatch && req.method === 'PATCH') {
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const body = await readJsonBody(req);
          const result = apiUpdateGoal(activeDb, parseInt(goalPatchMatch[1], 10), body);
          auditRestWrite('/api/goals/:id', result.success);
          return Response.json(result, { status: result.success ? 200 : result.status, headers });
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

        // ── Demo: auto-book candidate resolution ────────────────────
        // Which freshly imported rows match the predicted description —
        // server truth so the confirmation card names the exact transaction.
        // Read-only: the booking write happens only inside the WebMCP
        // substrate's commit, after the human approves the confirmation card.

        if (path === '/api/demo/autobook/candidates' && req.method === 'POST') {
          const body = await req.json() as unknown;
          const result = apiDemoAutoBookCandidates(activeDb, body);
          if (!result.ok) return Response.json({ error: result.error }, { status: 400, headers });
          return Response.json({ candidates: result.candidates }, { headers });
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
            const buf = await apiExportXlsx(activeDb, url.searchParams);
            return new Response(new Uint8Array(buf), {
              headers: {
                ...headers,
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': 'attachment; filename="transactions.xlsx"',
              },
            });
          } catch {
            return Response.json(
              { error: 'XLSX export failed.' },
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
        if (path === '/api/export/tax') {
          // Schedule C export of flagged deductions — Pro, like tax_flag itself.
          if (!hasLicense('pro')) {
            return Response.json(
              { error: 'Tax export is a Pro feature.', upgradeUrl: getCheckoutUrl('annual') },
              { status: 402, headers },
            );
          }
          const yearParam = url.searchParams.get('year');
          const year = yearParam ? Number(yearParam) : new Date().getFullYear();
          const format = url.searchParams.get('format') ?? 'xlsx';
          if (!Number.isInteger(year) || year < 1900 || year > 9999 || (format !== 'csv' && format !== 'xlsx')) {
            return Response.json({ error: 'year must be a 4-digit year and format csv or xlsx' }, { status: 400, headers });
          }
          const report = buildScheduleC(activeDb, year);
          const filename = `schedule-c-${year}.${format}`;
          if (format === 'csv') {
            return new Response(scheduleCToCsv(report), {
              headers: {
                ...headers,
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filename}"`,
              },
            });
          }
          return new Response(new Uint8Array(await scheduleCToXlsxBuffer(report)), {
            headers: {
              ...headers,
              'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'Content-Disposition': `attachment; filename="${filename}"`,
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
        if (path === '/api/chat/progress') {
          return Response.json({ progress: getCategorizeProgress() }, { headers });
        }
        if (path === '/api/chat/sessions') {
          return Response.json(apiChatSessions(activeDb), { headers });
        }
        const sessionMatch = path.match(/^\/api\/chat\/sessions\/(.+)$/);
        if (sessionMatch) {
          return Response.json(apiChatSessionHistory(activeDb, sessionMatch[1]), { headers });
        }

        if (path === '/api/chat' && req.method === 'POST') {
          const body = await req.json() as { query?: string; sessionId?: string; mentions?: unknown; localHandoff?: unknown };
          // Headers may have arrived while auth was off; re-check after the body read.
          if (authTurnedOnMidRequest()) return unauthorized();
          if (!body.query) {
            return Response.json({ error: 'query is required' }, { status: 400, headers });
          }
          // "@" mentions: shape-checked here, then every entity is re-read from
          // the DB (client labels are never trusted) into a context block.
          const mentions = validateMentions(body.mentions);
          if (!mentions.ok) {
            return Response.json({ error: mentions.error }, { status: 400, headers });
          }
          const contextBlock = resolveMentionContext(activeDb, mentions.mentions);
          // On-device subagent handoff (advisory): validated, its steps re-run
          // on this DB, rendered as a framed untrusted block after the mention
          // block. Invalid or oversized payloads render '' and never fail the chat.
          // Honoured only while subagent.enabled is on: with the flag off the field
          // is not even parsed, so a forged handoff cannot inject a block or make the
          // server run tools on a path the feature does not expose.
          const handoffBlock = apiLocalChatConfig().subagent.enabled
            ? await buildHandoffContext(body.localHandoff, { exec: serverReadExecutor(activeDb) })
            : '';
          if (authTurnedOnMidRequest()) return unauthorized();
          // The run belongs to this user: its approval cards are theirs alone,
          // and a user who cannot write gets every write denied (#156).
          const result = await handleChatMessage(body.query, body.sessionId, (contextBlock + handoffBlock) || undefined, {
            user: authEnabled && currentUser ? { id: currentUser.id, role: currentUser.role } : null,
          });
          // One chat run at a time (chat.ts activeChatRun): a concurrent
          // message is refused, never queued behind another run's approval.
          if (result.busy) {
            return Response.json({ error: result.answer, sessionId: result.sessionId }, { status: 409, headers });
          }
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

        // ── Demo: Privacy Validator (issue #95) ─────────────────────

        if (path === '/api/demo/privacy/start' && req.method === 'POST') {
          return Response.json(apiDemoPrivacyStart(activeDb), { headers });
        }

        if (path === '/api/demo/privacy/ledger') {
          try {
            return Response.json(apiDemoPrivacyLedger(activeDb, url.searchParams), { headers });
          } catch (err) {
            // Unknown/null run id (e.g. the server restarted and wiped run
            // state) — the panel re-arms. Writes no DB rows, so no canWrite
            // gate, exactly like the browser-trace recorder above.
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400, headers },
            );
          }
        }

        if (path === '/api/demo/privacy/exhibit') {
          try {
            return Response.json(apiDemoPrivacyExhibit(url.searchParams), { headers });
          } catch (err) {
            // Unknown slug → 400 (fixture slugs only, same guard as the arms).
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
          // A label is a human's act, and it feeds the training export: it needs the dashboard page's browser proof,
          // exactly like the judge queue (a token-bearing script or a cross-origin page must not be able to write one).
          const proof = requireBrowserProof(req, actualPort);
          if (proof) {
            for (const [k, v] of Object.entries(headers)) proof.headers.set(k, v);
            return proof;
          }
          if (authEnabled && currentUser && !canWrite(currentUser.role)) {
            return Response.json({ error: 'Forbidden' }, { status: 403, headers });
          }
          const id = parseInt(annotateMatch[1], 10);
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: { code: 'invalid_args', message: 'Request body must be valid JSON' } }, { status: 400, headers });
          }
          // Whether an agent had live access is computed here from server state (a header could be left out): a label
          // written then stays out of the default training export.
          const annotateUserId = authEnabled && currentUser ? currentUser.id : null;
          const agentPresent = annotateAgentPresent(activeDb, annotateUserId, getCurrentProfileName());
          const result = apiAnnotateInteraction(activeDb, id, body, { agentPresent });
          // The audit row records the same flag the stored label got (window rule), not a fresh live-only check.
          auditRestWrite('/api/interactions/:id/annotate', result.ok, agentPresent);
          if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers });
          return Response.json({ annotation: result.annotation }, { headers });
        }

        // ── Judge queue: a person accepts, rejects or revokes what an agent proposed ─────────────────
        if (path === '/api/judgements' || path.startsWith('/api/judgements/')) {
          const judgementResponse = await handleJudgementRoute(req, url, path, {
            activeDb,
            currentUser,
            authEnabled,
            port: actualPort,
            headers,
            profile: getCurrentProfileName(),
          });
          if (judgementResponse) return judgementResponse;
        }

        const runMatch = path.match(/^\/api\/runs\/(.+)$/);
        if (runMatch) {
          return Response.json(apiRunInteractions(activeDb, runMatch[1]), { headers });
        }

        if (path === '/api/annotations/stats') {
          return Response.json(apiAnnotationStats(activeDb), { headers });
        }

        // ── Training Export ──────────────────────────────────────────

        // Each of these is a separate, explicit per-export opt-in; anything but the literal "true" is off. The default
        // export is human labels only. The provenance header says what the file may contain.
        const exportFlags = (): ExportQualifyOptions => trainingExportFlags(url);

        if (path === '/api/export/training/sft') {
          const minRating = parseInt(url.searchParams.get('minRating') ?? '4', 10);
          const callTypesParam = url.searchParams.get('callTypes');
          const callTypes = callTypesParam ? callTypesParam.split(',') : ['agent'];
          const model = url.searchParams.get('model') ?? undefined;
          const flags = exportFlags();
          const jsonl = exportSftJsonl(activeDb, { minRating, callTypes, model, ...flags });
          return new Response(jsonl, {
            headers: {
              ...headers,
              'Content-Type': 'application/x-ndjson',
              'Content-Disposition': `attachment; filename="${flags.includeJudge ? 'wilson-sft-with-judge.jsonl' : 'wilson-sft.jsonl'}"`,
              'X-Wilson-Export-Provenance': exportProvenance(flags),
            },
          });
        }

        if (path === '/api/export/training/dpo') {
          const flags = exportFlags();
          const jsonl = exportDpoJsonl(activeDb, flags);
          return new Response(jsonl, {
            headers: {
              ...headers,
              'Content-Type': 'application/x-ndjson',
              'Content-Disposition': `attachment; filename="${flags.includeJudge ? 'wilson-dpo-with-judge.jsonl' : 'wilson-dpo.jsonl'}"`,
              'X-Wilson-Export-Provenance': exportProvenance(flags),
            },
          });
        }

        if (path === '/api/export/training/stats') {
          return Response.json(getTrainingStats(activeDb, exportFlags()), { headers });
        }

        return new Response('Not Found', { status: 404, headers });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500, headers }
        );
      }
  };

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: DASHBOARD_IDLE_TIMEOUT_S,
    // Never Bun's development error page: it prints source and absolute paths.
    development: false,
    error() {
      return new Response('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain', ...ANTI_FRAMING_HEADERS } });
    },
    async fetch(req, bunServer) {
      return withAntiFraming(await handleRequest(req, bunServer));
    },
  });

  const maintenanceTimer = setInterval(() => {
    try {
      getActiveDb(); // make sure the active profile is open and so included
      runMcpMaintenanceAll(getOpenDbs(), getCurrentProfileName());
    } catch (err) {
      console.error('[mcp-maintenance] sweep failed:', err);
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
  maintenanceTimers.set(server, maintenanceTimer);

  return { server, url: `http://localhost:${port}` };
}

/**
 * Stop the dashboard server.
 */
export function stopDashboardServer(server: ReturnType<typeof Bun.serve>): void {
  const timer = maintenanceTimers.get(server);
  if (timer) {
    clearInterval(timer);
    maintenanceTimers.delete(server);
  }
  server.stop();
}
