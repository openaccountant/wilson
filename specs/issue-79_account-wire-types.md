# Plan: Fix stale account wire-format types so Accounts and Liabilities render real balances

Decomposed from #54 (slice issue-79). UI-only contract fix plus wire-pinning tests; no server or DB changes.

## Problem

The dashboard UI's shared types in `src/dashboard/ui/src/types.ts` describe an account shape the API never sends:

- `Account` declares `{ id, name, type, institution, balance }` (lines ~17–23).
- `NetWorthResponse` declares `accounts: { name; type; balance }[]` (lines ~136–141).
- `NetWorthTrendPoint` declares `{ month, assets, liabilities, netWorth }` (lines ~233–238).

What the API actually sends (source of truth: `src/db/net-worth-queries.ts`, served by `src/dashboard/api.ts` + `src/dashboard/server.ts`; verified empirically against the seeded API):

- `GET /api/accounts` → `apiAccounts(db)` → `getAccounts(db, { active: true })` → `SELECT * FROM accounts WHERE is_active = 1` → full `AccountRow[]` with fields
  `id, name, account_type ('asset'|'liability'), account_subtype, institution, account_number_last4, current_balance, currency, is_active, notes, plaid_account_id, created_at, updated_at`. There is no `type` and no `balance`.
- `GET /api/net-worth` → `getNetWorthSummary(db)` → `{ totalAssets, totalLiabilities, netWorth, assetsBySubtype: {subtype,total,count}[], liabilitiesBySubtype: {subtype,total,count}[], accounts: AccountRow[] }`. The UI type omits the two `*BySubtype` arrays and types `accounts` wrong.
- `GET /api/net-worth/trend?months=N` → `getNetWorthTrend` → `{ date, totalAssets, totalLiabilities, netWorth }[]` (empty array when there are no snapshots).

Symptoms today, all from this one drift:

1. `AccountsTab` groups by `acct.type || 'Other'` (`AccountsTab.tsx:141`) — `type` is always undefined, so every account renders under "Other".
2. `AccountCard` renders `account.balance` (`AccountsTab.tsx:112, 123–124`) — undefined → NaN.
3. `LiabilitiesCard` filters `data.accounts.filter((a) => a.balance < 0)` (`LiabilitiesCard.tsx:28`) — never matches, so the per-account breakdown silently never renders. (Liability balances are stored positive — e.g. a 300000 mortgage — so even a real `balance`-based filter would be wrong.)
4. `NetWorthChart` XAxis uses `dataKey="month"` (`AccountsTab.tsx:~72`) — the wire field is `date`, so axis labels are blank.

The upcoming forecast card (parent #54) reads these same rows, so the contract must be fixed and pinned before it is built on.

## Changes

### 1. `src/dashboard/ui/src/types.ts` — correct the three types

Replace `Account`, `NetWorthResponse`, and `NetWorthTrendPoint` with the wire shapes. Keep the exported names — consumers (`AccountsTab`, `App.tsx`, `LiabilitiesCard`) import them by name.

```ts
// Mirrors AccountRow in src/db/net-worth-queries.ts — GET /api/accounts wire format.
export type AccountType = 'asset' | 'liability';

export interface Account {
  id: number;
  name: string;
  account_type: AccountType;
  account_subtype: string;
  institution: string | null;
  account_number_last4: string | null;
  current_balance: number;
  currency: string;
  is_active: number;
  notes: string | null;
  plaid_account_id: string | null;
  created_at: string;
  updated_at: string;
}

// Matches GET /api/net-worth response (NetWorthSummary in src/db/net-worth-queries.ts)
export interface NetWorthResponse {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  assetsBySubtype: { subtype: string; total: number; count: number }[];
  liabilitiesBySubtype: { subtype: string; total: number; count: number }[];
  accounts: Account[];
}

// Matches GET /api/net-worth/trend response
export interface NetWorthTrendPoint {
  date: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}
```

Notes:
- Do **not** import the server-side `AccountRow`/`NetWorthSummary` types into the UI — the UI build must not pull in bun/sqlite modules. Duplicate the shape and pin it with the tests in §4.
- `account_subtype` may become a literal union in a later slice if the forecast card needs it; `string` is enough here.

### 2. `src/dashboard/ui/src/tabs/AccountsTab.tsx` — read real fields

- `AccountCard`: swap `account.balance` → `account.current_balance` in all three spots (`isPositive`, the sign check, `fmt`).
- Grouping `useMemo` in `AccountsTab`: `const key = acct.account_type;` — drop the `|| 'Other'` fallback; `account_type` is non-null on the wire. Groups render as "ASSET" / "LIABILITY" (uppercased by existing CSS). Optional polish, not required: map the key to `Assets`/`Liabilities` for the group header.
- `NetWorthChart`: `XAxis dataKey="month"` → `dataKey="date"`. Leave the `netWorth` Area and tooltip formatter as-is (the plotted series key already matches).

### 3. `src/dashboard/ui/src/components/LiabilitiesCard.tsx` — detect liabilities correctly

- Line 28: `data.accounts.filter((a) => a.balance < 0)` → `data.accounts.filter((a) => a.account_type === 'liability' || a.current_balance < 0)` (type first; negative balance catches odd assets like overdrawn checking).
- Line 57: `fmt(acct.balance)` → `fmt(acct.current_balance)`.
- Optional: `key={acct.id}` instead of `key={acct.name}`.

`App.tsx` and `Header.tsx` consume `Account` but only use `id`/`name` — no code change needed; typecheck confirms.

### 4. `src/__tests__/dashboard-server.test.ts` — pin the wire contract

In the existing `accounts and net worth` describe block (currently lines ~359–410), add tests that seed the in-memory DB (`insertAccount`, `insertBalanceSnapshot`) and assert the exact field names the UI types declare:

- **Test: `GET /api/accounts rows carry exactly the field names the UI Account type declares`**
  - Seed one asset (`checking`, `current_balance: 5000`) and one liability (`credit_card`, `current_balance: 2000`).
  - For each returned row assert `Object.keys(row).sort()` deep-equals the sorted canonical list
    `['account_number_last4','account_subtype','account_type','created_at','currency','current_balance','id','institution','is_active','name','notes','plaid_account_id','updated_at']`
  - Spot-check values: `account_type === 'asset'`, `account_subtype === 'checking'`, `current_balance === 5000`, `institution === null`, `is_active === 1`, and the liability row's `account_type === 'liability'`.
- **Test: `GET /api/net-worth matches the UI NetWorthResponse type`**
  - Seed asset 10000 + liability 2000; assert top-level keys sort-equal
    `['accounts','assetsBySubtype','liabilitiesBySubtype','netWorth','totalAssets','totalLiabilities']`
    and `Object.keys(data.accounts[0]).sort()` matches the same canonical account list.
- **Test: `GET /api/net-worth/trend rows match the UI NetWorthTrendPoint type`**
  - Seed an account, then `insertBalanceSnapshot(db, { account_id: <id>, balance: 5000, snapshot_date: '2026-09-01' })` (signature: `{ account_id, balance, snapshot_date, source? }`, default source `'manual'`) so at least one trend row exists.
  - Assert each row's keys sort-equal `['date','netWorth','totalAssets','totalLiabilities']` and `typeof row.date === 'string'`.
- **Compile-time belt (same file):**
  ```ts
  import type { Account, NetWorthResponse, NetWorthTrendPoint } from '../dashboard/ui/src/types.js';
  // inside a test:
  const uiAccounts: Account[] = apiAccounts(db);
  const uiNetWorth: NetWorthResponse = apiNetWorth(db);
  const uiTrend: NetWorthTrendPoint[] = apiNetWorthTrend(db, new URLSearchParams());
  ```
  If the UI types ever drift from `AccountRow`/`NetWorthSummary`/the trend shape, root `tsc --noEmit` fails. These are type-only imports (erased at runtime), so `bun test` is unaffected.

Caveat to document in the test: the canonical key list is the `accounts` table's column set. If a later migration adds a column, these tests fail — intended, because the pin forces the UI type to be updated in the same slice.

### 5. `CHANGELOG.md`

Add one `fix:` bullet under `## [Unreleased]` → `### Fixes` describing the wire-format correction (references #79), matching the style of the existing entries.

## Out of scope

- No server/DB changes — the API and `net-worth-queries.ts` are the source of truth and stay as-is.
- No subtype-level grouping UI, no forecast card (parent #54's later slices build on this contract).
- No renames of UI files or exports.

## Verification

1. `bun test src/__tests__/dashboard-server.test.ts` — the new wire tests pass; then full `bun test`.
2. `bun run typecheck` — root tsc, including the new compile-time assertions.
3. Dashboard UI build: `cd src/dashboard/ui && bun install && bun run build` (this runs `tsc -b && vite build`; the worktree has no `src/dashboard/ui/node_modules` yet, so `bun install` there first). After fixing the types, `tsc` flags every remaining stale read (`.balance`, `.type`) — fix them all until the build is clean; that is the mechanism that guarantees no consumer was missed.
4. Manual check — start the standalone dashboard against the seeded profile: `bun run src/index.tsx -- --dashboard`, open http://localhost:3141, Accounts tab:
   - accounts grouped under ASSET / LIABILITY (no "Other" catch-all) with real dollar balances (no NaN);
   - the Liabilities card lists each liability account with its balance;
   - the net-worth trend chart shows date labels on the X axis.
   Sanity-check the wire directly: `curl -s localhost:3141/api/accounts | head` shows snake_case fields.
   If the active profile has no accounts, run the server against a scratch seeded DB instead (delete the scratch file after):
   ```ts
   // scratch-dashboard.ts
   import { createTestDb } from './src/__tests__/helpers.js';
   import { insertAccount } from './src/db/net-worth-queries.js';
   import { setInitialProfile, closeAll } from './src/dashboard/db-manager.js';
   import { startDashboardServer } from './src/dashboard/server.js';
   const db = createTestDb();
   insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 5230.4 });
   insertAccount(db, { name: 'Mortgage', account_type: 'liability', account_subtype: 'mortgage', current_balance: 289000 });
   insertAccount(db, { name: 'Visa', account_type: 'liability', account_subtype: 'credit_card', current_balance: 1250.9 });
   setInitialProfile('scratch', db);
   await startDashboardServer(db, 3141);
   process.on('SIGINT', () => { closeAll(); process.exit(0); });
   ```
   then `bun scratch-dashboard.ts` and open http://localhost:3141.

## Acceptance criteria mapping

- Shared types match wire format + surfaces read real fields → §1–3.
- Wire contract pinned by a seeded-database API test → §4.
- `bun test`, root typecheck, dashboard UI build pass → Verification 1–3.
- Manual check on the Accounts tab → Verification 4.