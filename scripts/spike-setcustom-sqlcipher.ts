#!/usr/bin/env bun
/**
 * Spike for issue #17: validate SQLCipher through bun:sqlite's Database.setCustomSQLite.
 *
 * Proves we can point bun:sqlite at Homebrew's libsqlcipher and get a real
 * encrypted-at-rest SQLite database with no npm dependencies.
 *
 * CRITICAL invariants exercised here:
 *   - Database.setCustomSQLite(dylibPath) MUST be called BEFORE any Database is
 *     constructed, and only after existsSync() confirms the file. Passing an
 *     invalid path segfaults Bun (oven-sh/bun#18811), so we guard with existsSync.
 *   - `PRAGMA key = "x'<hex>'"` MUST be the FIRST statement run on a keyed
 *     connection, before any other SQL touches the database.
 *
 * Run: bun run scripts/spike-setcustom-sqlcipher.ts
 * Exits nonzero if any check fails.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Locate the SQLCipher dylib and guard against the segfault footgun.
// ---------------------------------------------------------------------------
const DYLIB_CANDIDATES = [
  "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib",
  "/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib",
];
const dylibPath = DYLIB_CANDIDATES.find((p) => existsSync(p));

if (!dylibPath) {
  record(
    "dylib-exists",
    false,
    `no libsqlcipher.dylib at any of: ${DYLIB_CANDIDATES.join(", ")}`,
  );
  console.error("\nCannot continue without the SQLCipher dylib. Aborting.");
  process.exit(1);
}
record("dylib-exists", true, dylibPath);

// setCustomSQLite MUST happen before any Database is instantiated.
try {
  Database.setCustomSQLite(dylibPath);
  record("setCustomSQLite", true, "called before any Database construction");
} catch (err) {
  record("setCustomSQLite", false, String(err));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "sqlcipher-spike-"));
// 64 hex chars = 32-byte raw key. Raw-hex form avoids KDF passphrase derivation.
const KEY_HEX = "2b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfe";
const WRONG_KEY_HEX =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const dbPath = join(workDir, "spike.db");

/**
 * Open a keyed SQLCipher connection. Runs `PRAGMA key` as the FIRST statement,
 * then sets cipher_compatibility, then a probe SELECT to force the key to be
 * validated against the header (PRAGMA key alone is lazy).
 */
function openKeyed(path: string, keyHex: string, validate = true): Database {
  const db = new Database(path);
  // FIRST statement on the connection.
  db.exec(`PRAGMA key = "x'${keyHex}'"`);
  db.exec("PRAGMA cipher_compatibility = 4");
  if (validate) {
    // Touching schema forces SQLCipher to derive the key and decrypt page 1.
    db.query("SELECT count(*) FROM sqlite_master").get();
  }
  return db;
}

let allOk = true;

try {
  // -------------------------------------------------------------------------
  // (a) Open keyed DB, prove we're actually running SQLCipher.
  // -------------------------------------------------------------------------
  {
    const db = openKeyed(dbPath, KEY_HEX);
    const sqliteVersion = (
      db.query("SELECT sqlite_version() AS v").get() as { v: string }
    ).v;
    let cipherVersion = "";
    try {
      const row = db.query("PRAGMA cipher_version").get() as
        | { cipher_version: string }
        | undefined;
      cipherVersion = row?.cipher_version ?? "";
    } catch (err) {
      cipherVersion = `<error: ${err}>`;
    }
    const isCipher = cipherVersion.length > 0 && !cipherVersion.startsWith("<");
    record(
      "a: cipher_version present",
      isCipher,
      `sqlite_version=${sqliteVersion}, cipher_version=${cipherVersion || "(empty)"}`,
    );
    if (!isCipher) allOk = false;
    db.close();
  }

  // -------------------------------------------------------------------------
  // (b) Create table + rows, close, reopen with same key → rows readable.
  // -------------------------------------------------------------------------
  {
    const db = openKeyed(dbPath, KEY_HEX);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO t (name) VALUES ('alice'), ('bob'), ('carol')");
    db.close();

    const db2 = openKeyed(dbPath, KEY_HEX);
    const count = (
      db2.query("SELECT count(*) AS c FROM t").get() as { c: number }
    ).c;
    const names = (db2.query("SELECT name FROM t ORDER BY id").all() as {
      name: string;
    }[]).map((r) => r.name);
    const ok = count === 3 && names.join(",") === "alice,bob,carol";
    record("b: reopen with same key reads rows", ok, `count=${count}, names=[${names}]`);
    if (!ok) allOk = false;
    db2.close();
  }

  // -------------------------------------------------------------------------
  // (c) Reopen WITHOUT key → reading should fail.
  // -------------------------------------------------------------------------
  {
    let failedAsExpected = false;
    let detail = "";
    try {
      const db = new Database(dbPath);
      // No PRAGMA key. Reading an encrypted DB must error.
      db.query("SELECT count(*) FROM t").get();
      detail = "unexpectedly read encrypted DB with no key";
      db.close();
    } catch (err) {
      failedAsExpected = true;
      detail = `errored as expected: ${String(err).split("\n")[0]}`;
    }
    record("c: no-key read fails", failedAsExpected, detail);
    if (!failedAsExpected) allOk = false;
  }

  // -------------------------------------------------------------------------
  // (d) Reopen with WRONG key → should fail.
  // -------------------------------------------------------------------------
  {
    let failedAsExpected = false;
    let detail = "";
    try {
      const db = openKeyed(dbPath, WRONG_KEY_HEX);
      detail = "unexpectedly read encrypted DB with wrong key";
      db.close();
    } catch (err) {
      failedAsExpected = true;
      detail = `errored as expected: ${String(err).split("\n")[0]}`;
    }
    record("d: wrong-key read fails", failedAsExpected, detail);
    if (!failedAsExpected) allOk = false;
  }

  // -------------------------------------------------------------------------
  // (e) Raw bytes are not a plaintext SQLite header; system sqlite3 can't read.
  // -------------------------------------------------------------------------
  {
    const header = readFileSync(dbPath).subarray(0, 16);
    const plaintext = Buffer.from("SQLite format 3\0", "latin1");
    const notPlaintext = !header.equals(plaintext);
    record(
      "e1: header is not 'SQLite format 3\\0'",
      notPlaintext,
      `first16=${header.toString("hex")}`,
    );
    if (!notPlaintext) allOk = false;

    let sqlite3Blocked = false;
    let cliDetail = "";
    const systemSqlite3 = "/usr/bin/sqlite3";
    if (existsSync(systemSqlite3)) {
      try {
        const out = execFileSync(
          systemSqlite3,
          [dbPath, "SELECT count(*) FROM t;"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        cliDetail = `system sqlite3 unexpectedly read it: ${out.trim()}`;
      } catch (err: any) {
        sqlite3Blocked = true;
        const msg = (err.stderr || err.message || String(err)).toString().trim().split("\n")[0];
        cliDetail = `system sqlite3 rejected it: ${msg}`;
      }
    } else {
      // Absence of the system CLI shouldn't fail the spike; note it.
      sqlite3Blocked = true;
      cliDetail = `${systemSqlite3} not present, skipped`;
    }
    record("e2: system sqlite3 cannot read encrypted DB", sqlite3Blocked, cliDetail);
    if (!sqlite3Blocked) allOk = false;
  }

  // -------------------------------------------------------------------------
  // (f) WAL journal mode on the keyed DB works.
  // -------------------------------------------------------------------------
  {
    const db = openKeyed(dbPath, KEY_HEX);
    const mode = (
      db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string }
    ).journal_mode;
    db.exec("INSERT INTO t (name) VALUES ('dave')");
    const dave = db
      .query("SELECT name FROM t WHERE name = 'dave'")
      .get() as { name: string } | undefined;
    const ok = mode.toLowerCase() === "wal" && dave?.name === "dave";
    record("f: WAL mode works on keyed DB", ok, `journal_mode=${mode}, readback=${dave?.name}`);
    if (!ok) allOk = false;
    db.close();
  }

  // -------------------------------------------------------------------------
  // (g) Migration: plaintext DB → encrypted copy via sqlcipher_export.
  // -------------------------------------------------------------------------
  {
    const plainPath = join(workDir, "plain.db");
    const encPath = join(workDir, "migrated-enc.db");

    // Build an UNENCRYPTED database (no key).
    const plain = new Database(plainPath);
    plain.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY, memo TEXT, cents INTEGER)");
    plain.exec(
      "INSERT INTO ledger (memo, cents) VALUES ('coffee', -450), ('salary', 500000)",
    );

    // Attach an encrypted target and export into it, all from the plaintext handle.
    plain.exec(`ATTACH DATABASE '${encPath}' AS encrypted KEY "x'${KEY_HEX}'"`);
    plain.query("SELECT sqlcipher_export('encrypted')").get();
    plain.exec("DETACH DATABASE encrypted");
    plain.close();

    // Open the encrypted copy with the key and verify the data survived.
    const enc = openKeyed(encPath, KEY_HEX);
    const rows = enc.query("SELECT memo, cents FROM ledger ORDER BY id").all() as {
      memo: string;
      cents: number;
    }[];
    const ok =
      rows.length === 2 &&
      rows[0].memo === "coffee" &&
      rows[0].cents === -450 &&
      rows[1].memo === "salary" &&
      rows[1].cents === 500000;

    // Also confirm the migrated file is actually encrypted at rest.
    const encHeader = readFileSync(encPath).subarray(0, 16);
    const encrypted = !encHeader.equals(Buffer.from("SQLite format 3\0", "latin1"));
    record(
      "g: migration plaintext→encrypted preserves data",
      ok && encrypted,
      `rows=${JSON.stringify(rows)}, encrypted-at-rest=${encrypted}`,
    );
    if (!(ok && encrypted)) allOk = false;
    enc.close();
  }

  // -------------------------------------------------------------------------
  // (h) :memory: DB with NO key works normally (test-suite invariant).
  // -------------------------------------------------------------------------
  {
    const mem = new Database(":memory:");
    mem.exec("CREATE TABLE m (x INTEGER)");
    mem.exec("INSERT INTO m VALUES (1), (2), (3)");
    const sum = (mem.query("SELECT sum(x) AS s FROM m").get() as { s: number }).s;
    const ok = sum === 6;
    record("h: :memory: DB with no key works", ok, `sum=${sum}`);
    if (!ok) allOk = false;
    mem.close();
  }
} catch (err) {
  record("UNEXPECTED-EXCEPTION", false, String(err));
  allOk = false;
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log("\n=== SPIKE VERDICT ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} checks passed`);
console.log(allOk ? "OVERALL: PASS" : "OVERALL: FAIL");
process.exit(allOk ? 0 : 1);
