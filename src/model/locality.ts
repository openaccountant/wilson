/**
 * Does a model call stay on this machine? The one rule every "runs on this
 * device" / "answered on your laptop" claim derives from.
 *
 * ProviderDef.isLocal says what a provider CAN be; this says what a given
 * model actually is, given where the provider is pointed:
 * - an Ollama cloud model (`gpt-oss:120b-cloud`, `glm-4.6:cloud`) is proxied
 *   by the local daemon to ollama.com, so it is cloud whatever the base URL;
 * - a local provider with a configurable base URL (OLLAMA_BASE_URL) is local
 *   only when that URL's host is loopback (localhost, 127.0.0.0/8, ::1). A
 *   LAN box or a remote host is another machine, and an unparseable URL is
 *   treated the same way.
 * Cloud providers stay cloud. Anything unknown counts as not local: the
 * failure to avoid is claiming local processing that did not happen.
 */

import { getProviderById, resolveProvider, type ProviderDef } from '../providers.js';
import { isRemoteOllamaModel } from '../utils/ollama.js';

type Env = Record<string, string | undefined>;

/**
 * Base-URL setting per local provider whose endpoint is configurable, with the
 * default the provider factory uses (src/model/providers/index.ts).
 * Transformers.js runs in-process and has none.
 */
const LOCAL_BASE_URLS: Record<string, { envVar: string; fallback: string }> = {
  ollama: { envVar: 'OLLAMA_BASE_URL', fallback: 'http://localhost:11434' },
};

/** The base URL a local provider is pointed at; undefined when it has no configurable endpoint. */
export function localProviderBaseUrl(providerId: string, env: Env = process.env): string | undefined {
  const base = LOCAL_BASE_URLS[providerId];
  if (!base) return undefined;
  return env[base.envVar] || base.fallback;
}

/** IPv4-mapped IPv6 loopback as URL normalises it: [::ffff:127.0.0.1] → ::ffff:7f00:1. */
const MAPPED_V4_LOOPBACK = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/;

/**
 * True for localhost, 127.0.0.0/8 and ::1 (brackets optional), compared as URL
 * normalises hostnames. Nothing else counts, not even 0.0.0.0 or *.localhost.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1' || MAPPED_V4_LOOPBACK.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4[1] === '127' && v4.slice(2).every((o) => Number(o) <= 255);
}

/** True when the URL parses and its host is loopback. URL normalises 127.1, 0x7f.0.0.1 and 0:0:0:0:0:0:0:1 first. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Host of a base URL for display, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Ollama's cloud models carry a `cloud` tag: `glm-4.6:cloud`, or a size tag
 * ending `-cloud` (`gpt-oss:120b-cloud`). Accepts the id with or without the
 * `ollama:` prefix. Any `-cloud` in the id counts, erring toward cloud.
 */
export function isOllamaCloudModel(model: string): boolean {
  const id = model.toLowerCase();
  return id.endsWith(':cloud') || id.includes('-cloud');
}

export interface ModelLocality {
  /** The provider the model routes to. */
  provider: ProviderDef;
  /** True only when the call stays on this machine. */
  local: boolean;
  /**
   * Who answers, for a badge: the provider's display name, or for a local
   * provider that is not local here, 'Ollama Cloud' / 'Ollama at <host>'.
   */
  displayName: string;
  /**
   * Set only for a local runtime pointed at another machine (a non-loopback
   * OLLAMA_BASE_URL that parses): that machine's host, for wording that says
   * "another machine" rather than "cloud". Still not local.
   */
  remoteHost?: string;
}

/** Locality of a call to `model` (with or without its provider prefix) on provider `def`. */
export function providerCallLocality(def: ProviderDef, model: string, env: Env = process.env): ModelLocality {
  if (!def.isLocal) return { provider: def, local: false, displayName: def.displayName };
  if (def.id === 'ollama' && (isOllamaCloudModel(model) || isRemoteOllamaModel(model))) {
    return { provider: def, local: false, displayName: `${def.displayName} Cloud` };
  }
  const base = localProviderBaseUrl(def.id, env);
  if (base !== undefined && !isLoopbackUrl(base)) {
    const host = hostOf(base);
    if (!host) return { provider: def, local: false, displayName: def.displayName };
    return { provider: def, local: false, displayName: `${def.displayName} at ${host}`, remoteHost: host };
  }
  return { provider: def, local: true, displayName: def.displayName };
}

/** Locality of a prefixed model id (e.g. 'ollama:llama3.1'), routed the way callLlm routes it. */
export function modelLocality(model: string, env: Env = process.env): ModelLocality {
  return providerCallLocality(resolveProvider(model), model, env);
}

/** True only when a call to `model` stays on this machine. */
export function isModelLocal(model: string, env: Env = process.env): boolean {
  return modelLocality(model, env).local;
}

/**
 * Locality of a recorded call (a trace row's provider id + model). Undefined
 * when the provider id is not in the registry: the caller decides what an
 * unrecognised provider means.
 */
export function recordedCallLocality(providerId: string, model: string, env: Env = process.env): ModelLocality | undefined {
  const def = getProviderById(providerId);
  return def ? providerCallLocality(def, model, env) : undefined;
}
