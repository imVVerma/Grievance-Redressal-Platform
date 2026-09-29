// Lifecycle for the throwaway test server.
//
// The backend opens its database relative to its own source directory, so the
// only safe way to run tests against real code is to start a second server
// process pointed at a copy of the database. This module owns that whole
// arrangement: make the copy, start the process, hand back a base URL, and on
// the way out prove the real database was never opened for writing.
//
// The "prove it" part matters. A test suite that can silently write to the real
// grievance database is worse than no suite, because it looks like coverage.

import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = join(here, '..', '..');
const LIVE_DB = join(BACKEND_DIR, 'gap.db');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/** Checksum of every row of every user table, so writes are detected, not just file mtime. */
export function fingerprint(dbPath = LIVE_DB) {
  if (!existsSync(dbPath)) return 'missing';
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    const hash = createHash('sha256');
    for (const table of tables) {
      hash.update(`\n#${table}\n`);
      // Row order is unspecified without ORDER BY, so pin it by rowid where the
      // table has one and fall back to the full ordered dump otherwise.
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const order = cols.length && cols.includes('submission_id')
        ? ' ORDER BY ' + cols.join(', ')
        : '';
      for (const row of db.prepare(`SELECT * FROM ${table}${order}`).all()) {
        hash.update(JSON.stringify(row) + '\n');
      }
    }
    return hash.digest('hex');
  } finally {
    db.close();
  }
}

/**
 * Start a server on `port` against a private copy of the database.
 * Returns { base, dbPath, port, stop }.
 */
export async function startTestServer({ port = 4474 } = {}) {
  const before = fingerprint();

  const dir = mkdtempSync(join(tmpdir(), 'gap-tests-'));
  const dbPath = join(dir, 'gap.db');
  copyFileSync(LIVE_DB, dbPath);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(port), GAP_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (code ${child.exitCode}):\n${output}`);
    }
    try {
      const res = await fetch(`${base}/departments`);
      if (res.ok) { ready = true; break; }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`test server did not become ready on ${base}:\n${output}`);
  }

  return {
    base,
    port,
    dbPath,
    liveDbPath: LIVE_DB,
    get output() { return output; },
    async stop() {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((r) => child.once('exit', () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 3000)),
      ]);
      if (!exited) child.kill('SIGKILL');
      // Give better-sqlite3 a moment to release the file before removing it.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { liveDbUnchanged: fingerprint() === before };
    },
  };
}
