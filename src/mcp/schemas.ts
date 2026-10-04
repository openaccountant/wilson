/**
 * Request-body schemas for the `/api/mcp/*` routes. Every body is parsed with
 * a strict zod object, so an unknown key or a wrong type is a 400 with a
 * message, never a silently ignored field.
 */
import { z } from 'zod';

/** Header carrying the tab's session generation. A UUID v4: the bridge mints it with crypto.randomUUID(). */
export const SESSION_HEADER = 'X-Wilson-Agent-Session';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

const toolName = z.string().min(1).max(30);
const toolArgs = z.record(z.string(), z.unknown()).default({});

/**
 * `POST /api/mcp/call`, the one tool path (the session travels in the header). The answer's `kind` says what the
 * server did: `read` (data), `operation` (a change or an Ask waiting for a card) or `page` (authorized; the page acts).
 */
export const CallBody = z
  .object({
    grantId: z.uuid({ message: 'grantId must be a UUID' }),
    tool: toolName,
    args: toolArgs,
    transport: z.enum(['imperative', 'declarative', 'page']).default('imperative'),
  })
  .strict();

/** `POST /api/mcp/grants` */
export const GrantsBody = z
  .object({
    sessionGeneration: z.string().min(1).max(200).optional(),
    tools: z.array(toolName).min(1).max(20),
  })
  .strict();

/** `POST /api/mcp/grants/revoke-session` */
export const RevokeSessionBody = z
  .object({
    sessionGeneration: z.string().min(1).max(200).optional(),
  })
  .strict();

/** `POST /api/mcp/client-tokens`. The name is a user label; the mint rules live in src/mcp/client-tokens.ts. */
export const ClientTokenBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    tools: z.array(toolName).min(1).max(20),
    expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30),
  })
  .strict();

/** `PUT /api/mcp/client-tokens/:id/tools`: the full replacement tool list (the mint rules apply again). */
export const ClientTokenToolsBody = z
  .object({
    tools: z.array(toolName).min(1).max(20),
  })
  .strict();

/**
 * `PUT /api/mcp/settings` (admin). `enabled` is the global kill switch; `grantTtlMinutes` is per profile and
 * applies to new grants only; `judgeDailyLimit` is the trace judge's daily cap and is set only here, never by a tool.
 */
export const SettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    grantTtlMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.literal(720)]).optional(),
    judgeDailyLimit: z.number().int().min(1).max(2000).optional(),
  })
  .strict();

/** `PUT /api/mcp/policies/:tool`. The value is checked against the tool's allowed policies by `setPolicy`, which explains a refusal. */
export const PolicyBody = z
  .object({
    policy: z.string().min(1).max(10),
  })
  .strict();

/** `GET /api/mcp/audit` query string. */
export const AuditQuery = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  tool: z.string().max(80).optional(),
  decision: z.string().max(40).optional(),
  transport: z.string().max(20).optional(),
  since: z.string().max(40).optional(),
});

/** One-line summary of the first zod issues, for a 400 body. */
export function describeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
      return issue.code === 'unrecognized_keys'
        ? `unknown field ${(issue as { keys: string[] }).keys.map((k) => `"${k.slice(0, 30)}"`).join(', ')}`
        : `${field}: ${issue.message}`;
    })
    .join('; ');
}
