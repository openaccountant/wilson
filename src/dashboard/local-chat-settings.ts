/**
 * PUT /api/config/local-chat: turn on-device (WebGPU) chat on or off for the
 * active profile. Same posture as PUT /api/prelabel/settings: JSON only (forces
 * a CORS preflight), browser proof (the dashboard page itself, never a
 * cross-site form or a header-less script), admin-only when auth is on. Writes
 * the `localChatEnabled` setting and answers with the fresh config.
 *
 * Errors are `{error:{code,message}}` with a real HTTP status.
 */

import { z } from 'zod';
import { getLocalChatModelConfig, LOCAL_CHAT_ENABLED_KEY } from '../model/local-chat.js';
import { requireBrowserProof } from '../prelabel/origin-gate-interim.js';
import { setSetting } from '../utils/config.js';

export interface LocalChatSettingsContext {
  /** The server's shared response headers. */
  headers: Record<string, string>;
  /** Actual bound port (server.port), for the origin allowlist. */
  port: number;
  /** False for a signed-in viewer when auth is on (the canWrite guard). */
  mayWrite: boolean;
}

const SettingsBody = z.object({ enabled: z.boolean() }).strict();

function errorResponse(status: number, code: string, message: string, headers: Record<string, string>): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export async function handleLocalChatSettingsPut(req: Request, ctx: LocalChatSettingsContext): Promise<Response> {
  const { headers } = ctx;
  const contentType = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return errorResponse(415, 'unsupported_media_type', 'Content-Type must be application/json', headers);
  }
  const denied = requireBrowserProof(req, ctx.port);
  if (denied) return new Response(denied.body, { status: denied.status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (!ctx.mayWrite) return errorResponse(403, 'forbidden', 'Forbidden', headers);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, 'invalid_body', 'Body must be valid JSON', headers);
  }
  const parsed = SettingsBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), headers);
  }
  if (!setSetting(LOCAL_CHAT_ENABLED_KEY, parsed.data.enabled)) {
    return errorResponse(500, 'write_failed', 'Could not write settings', headers);
  }
  return Response.json(getLocalChatModelConfig(), { headers });
}
