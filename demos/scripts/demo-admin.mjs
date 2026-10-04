// DEMO-ONLY credentials for the `demo` profile's dashboard admin.
//
// These are public, fixed and deliberately weak: they exist so recordings and
// sandboxed workshops can log the dashboard in non-interactively. Never reuse
// them on a profile that holds real data. scripts/demo-enable-auth.ts creates
// this admin (on the `demo` profile only); demos/scripts/record-webmcp-agent.mjs
// logs in with it.
export const DEMO_PROFILE = 'demo';
export const DEMO_ADMIN = { username: 'demo-admin', password: 'demo-only-not-a-secret' };
