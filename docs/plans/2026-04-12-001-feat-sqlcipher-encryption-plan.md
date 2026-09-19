# Plan: SQLCipher Encryption for Wilson's SQLite Database

## Context

**Issue:** [openaccountant/wilson#1](https://github.com/openaccountant/wilson/issues/1)

**Problem:** Wilson stores all consumer financial data (including Plaid-sourced transactions, account metadata, balances) in an unencrypted SQLite database at `~/.openaccountant/profiles/{name}/data.db`. This violates Plaid's security requirements for production access. Encryption at rest must be implemented before Plaid production launch.

**Critical constraint:** Wilson runs on the **Bun runtime**. Bun's built-in `bun:sqlite` has **no encryption support**. The compat layer (`src/db/compat-sqlite.ts`) currently wraps `bun:sqlite` to emulate better-sqlite3's API.

## Approach: Replace bun:sqlite with `@journeyapps/sqlcipher` via NAPI

After evaluating four approaches:

| Approach | Verdict | Reason |
|----------|---------|--------|
| A. Bun FFI to libsqlcipher | Reject | Disproportionate effort — must reimplement entire SQLite C API |
| B. Application-level column encryption | Reject | Breaks SQL aggregations/filters in all 46 query functions |
| **C. better-sqlite3 + SQLCipher (NAPI)** | **Recommended** | Minimal changes, proven library, clean migration path |
| D. External file encryption | Reject | File unencrypted during session, breaks WAL mode |

The compat layer is the single chokepoint — switching its backend from `bun:sqlite` to `@journeyapps/sqlcipher` gives us full SQLCipher with minimal downstream impact. The `@param` → `$param` rewriting becomes unnecessary since better-sqlite3 natively uses `@param`.

## Requirements Trace

- R1. Encrypt database with SQLCipher (issue requirement)
- R2. Key derivation from passphrase or OS keychain (issue requirement)
- R3. Migration path: detect unencrypted → encrypt (issue requirement)
- R4. All Plaid-sourced data encrypted at rest (Plaid security requirement)
- R5. Performance negligible for <100K transactions (issue requirement)

## Scope Boundaries

- **In scope:** SQLCipher integration, key management (macOS keychain + passphrase fallback), unencrypted→encrypted migration, test updates
- **Not in scope:** Linux/Windows keychain integration (follow-up), re-keying UI, Plaid production launch gating

## Key Technical Decisions

- **`@journeyapps/sqlcipher` over `better-sqlite3-multiple-ciphers`:** More actively maintained, bundles prebuilt binaries, proven API compatibility. Fallback to `better-sqlite3-multiple-ciphers` if NAPI issues arise.
- **Key storage in OS keychain (macOS):** Reuses existing `src/utils/keychain.ts` (proven for Plaid tokens). Avoids storing keys on disk. Account name: `db-encryption-{profileName}`.
- **Passphrase fallback for non-macOS:** PBKDF2 key derivation from user passphrase. Salt stored in profile directory. No extra dependencies (uses Node `crypto` module).
- **Compat layer becomes thinner:** Removing `rewriteSQL` and `prefixParams` since better-sqlite3 natively handles `@param` syntax. The 98-line wrapper simplifies significantly.
- **In-memory test DBs unaffected:** SQLCipher `:memory:` databases work without a key. `createTestDb()` requires no changes.

## Relevant Code and Patterns

- `src/db/compat-sqlite.ts` (98 lines) — single-file SQLite abstraction, the only file importing `bun:sqlite`
- `src/db/database.ts` (20 lines) — `initDatabase()`, opens DB, sets WAL + foreign keys, runs migrations
- `src/db/migrations.ts` (111 lines) — 21 versioned migrations, idempotent, transactional
- `src/utils/keychain.ts` (66 lines) — macOS keychain via `security` CLI, `setSecret`/`getSecret`/`deleteSecret`
- `src/dashboard/db-manager.ts` (79 lines) — `Map<string, Database>` connection pool, per-profile
- `src/profile/active.ts` (67 lines) — active profile resolution, legacy data migration pattern (lines 22-29)
- `src/__tests__/helpers.ts` — `createTestDb()` using `Database(':memory:')`

## Open Questions

### Resolved During Planning

- **Q: Can better-sqlite3 NAPI modules run under Bun?** Bun 1.2.x has mature NAPI support, but this must be validated in Unit 1 before proceeding. This is the critical-path risk gate.
- **Q: Does SQLCipher support WAL mode?** Yes, with the same key for all connections to a file. Multi-profile dashboard (one connection per profile) is fine.

### Deferred to Implementation

- **Q: Exact PBKDF2 iteration count for passphrase fallback.** Will benchmark during implementation to balance security vs. startup time.
- **Q: Whether `@journeyapps/sqlcipher` prebuilt binaries cover all CI platforms.** Will discover during Unit 8.

## Implementation Units

- [ ] **Unit 1: Validate `@journeyapps/sqlcipher` under Bun NAPI**

  **Goal:** Confirm SQLCipher loads and works under Bun before committing to the approach.

  **Requirements:** R1

  **Dependencies:** None — this is the risk gate.

  **Files:**
  - Modify: `package.json`
  - Test: manual smoke test (open encrypted DB, write, read, verify wrong key fails)

  **Approach:**
  - `bun add @journeyapps/sqlcipher`
  - Write a throwaway script that creates an encrypted DB, inserts data, closes, reopens with key, reads data
  - If it fails, try `better-sqlite3-multiple-ciphers` as fallback
  - If both fail, this approach is blocked — escalate

  **Test scenarios:**
  - Happy path: open DB with key, write row, close, reopen with same key, row is readable
  - Error path: open encrypted DB with wrong key → throws error
  - Edge case: open `:memory:` DB without key → works normally

  **Verification:** SQLCipher opens, encrypts, and queries a file-based database under `bun run`.

- [ ] **Unit 2: Rewrite compat-sqlite.ts to use SQLCipher backend**

  **Goal:** Replace `bun:sqlite` with `@journeyapps/sqlcipher` in the compat layer. Add optional `key` parameter to `Database` constructor.

  **Requirements:** R1

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/db/compat-sqlite.ts`
  - Test: `src/__tests__/compat-sqlite.test.ts`

  **Approach:**
  - Replace `import { Database as BunDatabase } from 'bun:sqlite'` with `import Database from '@journeyapps/sqlcipher'`
  - Remove `rewriteSQL()` and `prefixParams()` — better-sqlite3 natively uses `@param`
  - `CompatStatement` becomes a thin passthrough (or removed entirely if the API matches)
  - Add optional `key` to constructor: when provided, call `this.db.pragma(\`key='...'\`)` immediately after open
  - Preserve the existing `Database` export interface so all 100+ consumers are unaffected

  **Patterns to follow:** Current compat-sqlite.ts structure — keep the same exported `Database` class with same method signatures.

  **Test scenarios:**
  - Happy path: all existing compat-sqlite tests pass without modification (API compatibility preserved)
  - Happy path: `Database(path, { key })` opens an encrypted DB, pragma/prepare/exec work normally
  - Edge case: `Database(':memory:')` without key works (tests rely on this)
  - Error path: `Database(encryptedPath)` without key → fails to read

  **Verification:** `bun test src/__tests__/compat-sqlite.test.ts` passes. Manual check that an encrypted DB file is not readable with a hex editor.

- [ ] **Unit 3: Key management module**

  **Goal:** Provide key generation, storage (keychain), and retrieval for database encryption. Passphrase fallback for non-macOS.

  **Requirements:** R2

  **Dependencies:** Unit 1

  **Files:**
  - Create: `src/db/encryption-key.ts`
  - Test: `src/__tests__/encryption-key.test.ts`

  **Approach:**
  - `getEncryptionKey(profileName)` — retrieve from keychain (`getSecret('db-encryption-{profileName}')`)
  - `initEncryptionKey(profileName)` — generate random 256-bit hex key, store via `setSecret`
  - `hasEncryptionKey(profileName)` — check if key exists in keychain
  - Non-macOS fallback: prompt for passphrase, derive key via PBKDF2, store salt in `~/.openaccountant/profiles/{name}/encryption-salt`

  **Patterns to follow:** `src/utils/keychain.ts` — same `setSecret`/`getSecret` pattern with `openaccountant` service name.

  **Test scenarios:**
  - Happy path: `initEncryptionKey` generates a key, `getEncryptionKey` retrieves it
  - Happy path: `hasEncryptionKey` returns false before init, true after
  - Edge case: non-macOS platform → passphrase prompt path activated
  - Error path: keychain write fails → falls back to passphrase

  **Verification:** Key round-trips through keychain on macOS. Passphrase fallback produces a deterministic key from the same passphrase + salt.

- [ ] **Unit 4: Update `initDatabase()` to handle encryption**

  **Goal:** Wire key resolution into the database initialization path. All entry points get encryption transparently.

  **Requirements:** R1, R2, R4

  **Dependencies:** Units 2, 3

  **Files:**
  - Modify: `src/db/database.ts`
  - Test: `src/__tests__/database.test.ts` (create if needed)

  **Approach:**
  - `initDatabase()` calls `getEncryptionKey(profileName)` to resolve the key
  - Passes key to `new Database(resolvedPath, { key })`
  - First run (no key exists): calls `initEncryptionKey(profileName)` to generate and store
  - If DB file exists but is unencrypted (detected by reading first 16 bytes — unencrypted SQLite starts with `"SQLite format 3\0"`): triggers migration (Unit 5)
  - Existing pragma setup (WAL, foreign keys) and migration runner unchanged

  **Test scenarios:**
  - Happy path: new DB created encrypted when key exists
  - Happy path: first-run generates key, creates encrypted DB
  - Integration: `initDatabase` → migrations run successfully on encrypted DB
  - Edge case: `:memory:` path → no encryption applied

  **Verification:** `initDatabase()` produces an encrypted file that can't be read without the key.

- [ ] **Unit 5: Unencrypted-to-encrypted migration**

  **Goal:** Detect existing unencrypted databases and migrate them to encrypted format.

  **Requirements:** R3

  **Dependencies:** Units 2, 3, 4

  **Files:**
  - Create: `src/db/encrypt-migrate.ts`
  - Test: `src/__tests__/encrypt-migrate.test.ts`

  **Approach:**
  - Detect unencrypted: read first 16 bytes of `.db` file — if `"SQLite format 3\0"`, it's unencrypted
  - Open unencrypted DB (no key)
  - Use SQLCipher's `ATTACH DATABASE 'encrypted.db' AS encrypted KEY 'the-key'` + `SELECT sqlcipher_export('encrypted')` to create encrypted copy
  - Rename: `data.db` → `data.db.unencrypted-backup`, `encrypted.db` → `data.db`
  - Log success, tell user they can delete backup after verification

  **Patterns to follow:** `src/profile/active.ts` lines 22-29 — legacy data migration with user notification.

  **Test scenarios:**
  - Happy path: unencrypted DB with data → encrypted DB with same data, backup created
  - Happy path: already-encrypted DB → no migration triggered
  - Edge case: empty unencrypted DB → migrates cleanly
  - Error path: migration fails mid-way → original DB untouched, no partial state

  **Verification:** Round-trip test: create unencrypted DB with known data → migrate → open encrypted → verify data matches.

- [ ] **Unit 6: Update dashboard db-manager for per-profile keys**

  **Goal:** Ensure multi-profile dashboard resolves encryption keys per profile.

  **Requirements:** R1, R4

  **Dependencies:** Unit 4

  **Files:**
  - Modify: `src/dashboard/db-manager.ts`

  **Approach:**
  - `openDb(profileName)` already calls `initDatabase(paths.database)`. Since `initDatabase` now handles key resolution internally, this may require no changes.
  - Verify that switching profiles (`switchProfile`) correctly opens each profile's DB with its own key.
  - Verify `closeAll()` still works.

  **Test scenarios:**
  - Happy path: two profiles with different encryption keys → both accessible via dashboard
  - Integration: `switchProfile` → new DB opens with correct key, chat session reinitializes

  **Verification:** Dashboard serves data from multiple encrypted profiles without key errors.

- [ ] **Unit 7: Encryption-specific tests**

  **Goal:** Add test coverage for encryption integration points.

  **Requirements:** R1, R5

  **Dependencies:** Units 2, 3, 5

  **Files:**
  - Modify: `src/__tests__/helpers.ts` (if needed)
  - Create: `src/__tests__/encryption-integration.test.ts`

  **Approach:**
  - Verify all existing tests still pass (in-memory DBs unaffected)
  - Add integration tests: create encrypted DB → run full query suite → verify results
  - Add performance benchmark: insert 100K transactions into encrypted DB, run common queries, verify acceptable latency
  - Add migration round-trip test with realistic data

  **Test scenarios:**
  - Happy path: full query suite (P&L, budgets, categorization) works on encrypted DB
  - Edge case: 100K transactions → query performance within acceptable range
  - Integration: `createTestDb()` continues to work for all existing tests (no key needed for `:memory:`)

  **Verification:** `bun test` passes. Performance benchmark shows negligible overhead for <100K transactions.

- [ ] **Unit 8: CI and distribution**

  **Goal:** Ensure CI runs with the NAPI module and prebuilt binaries cover target platforms.

  **Requirements:** R1

  **Dependencies:** Units 1-7

  **Files:**
  - Modify: `.github/workflows/` CI config
  - Modify: `package.json` (if postinstall needed)

  **Approach:**
  - Verify `@journeyapps/sqlcipher` prebuilt binaries work in CI (macOS, Linux)
  - Add encryption tests to CI pipeline
  - Document any system dependencies if prebuilt binaries don't cover a platform

  **Test expectation:** CI green with encryption tests passing.

  **Verification:** CI pipeline passes on all target platforms.

## System-Wide Impact

- **Interaction graph:** `initDatabase()` is called by every entry point (CLI, headless, dashboard, reports). All get encryption transparently. The 100+ files importing `Database` type are unaffected — the interface doesn't change.
- **Error propagation:** Wrong key → SQLCipher throws at open time. This surfaces immediately, not during queries. Clear error message needed: "Database encrypted — passphrase required" or "Invalid encryption key".
- **State lifecycle risks:** The unencrypted→encrypted migration (Unit 5) creates a backup before replacing. No partial state if migration fails.
- **API surface parity:** Dashboard API, headless mode, and CLI all use the same `initDatabase()` path. No separate encryption handling needed.
- **Unchanged invariants:** All 46 query functions, all 21 migrations, all tool initializations — none change. The `Database` export interface is preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@journeyapps/sqlcipher` NAPI fails under Bun 1.2.x | Unit 1 is a dedicated risk gate. Fallback: `better-sqlite3-multiple-ciphers`. If both fail, escalate before investing in remaining units. |
| Performance regression vs. native bun:sqlite | Benchmark in Unit 7. For <100K rows, SQLCipher overhead is typically <5%. |
| Non-macOS keychain not supported | Passphrase fallback covers Linux/Windows. Native keychain (libsecret, wincred) is a follow-up. |
| Bun version upgrade breaks NAPI compat | Pin Bun version in CI (already pinned to 1.2.22). Test on upgrade. |

## Sources & References

- **Origin issue:** [openaccountant/wilson#1](https://github.com/openaccountant/wilson/issues/1)
- Security docs: `plaid-security-questionnaire.md` Q7, `information-security-policy.md` §5.2
- Related code: `src/db/compat-sqlite.ts`, `src/utils/keychain.ts`
- SQLCipher docs: https://www.zetetic.net/sqlcipher/sqlcipher-api/
