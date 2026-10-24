/**
 * Words for the sign-in page (#193): what this is, what the Agent access
 * button is, and why Sign in is not available yet. Pure, so
 * src/__tests__/sign-in-copy.test.ts can pin it. Copy only: the login form
 * and the server's checks are unchanged.
 */

/** Loopback names the dashboard binds to by default (src/dashboard/server.ts, 127.0.0.1). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * One line on what this is. On a loopback address the server really is this
 * computer; opened from another device (an auth-on LAN bind), it is the
 * household's own machine, still not a cloud service.
 */
export function whatThisIs(hostname: string): string {
  return isLoopbackHost(hostname)
    ? "Your household's money dashboard. Runs on this computer."
    : "Your household's money dashboard. Runs on your household's own computer, not in the cloud.";
}

/**
 * The Agent access button (bottom-left, drawn by the WebMCP bridge): what it
 * controls, in the same terms as the bridge panel and Settings → Agent access.
 */
export const AGENT_ACCESS_HINT =
  'The Agent access button in the bottom-left corner controls what AI agents may do in this dashboard. ' +
  'Agents get no tools unless they are granted, and any change they propose waits for a person to approve it.';

/** Why Sign in is disabled, or null when it can be pressed. */
export function signInBlockedReason(username: string, password: string): string | null {
  const user = username.trim() !== '';
  const pass = password !== '';
  if (user && pass) return null;
  if (user) return 'Enter your password.';
  if (pass) return 'Enter your username.';
  return 'Enter your username and password.';
}
