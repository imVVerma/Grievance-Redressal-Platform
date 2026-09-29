// Test entry point:  cd backend && npm test
//
// Starts one throwaway server, runs every suite in this directory against it,
// tears it down, and reports. Suites are plain modules exporting a default
// function that receives an assertion object, so adding a suite is one new file
// and one line in SUITES below.
//
// Flags:
//   --filter <substring>   run only suites whose name contains <substring>
//   --port <n>             use a different port (default 4474)
//   --keep-db              leave the throwaway database on disk for inspection

import { setContext, suite } from './lib/harness.mjs';
import { startTestServer } from './lib/server.mjs';

import bounceSuite from './bounce.test.mjs';
import regressionSuite from './regression.test.mjs';
import frontendSuite from './frontend.test.mjs';

const SUITES = [
  { name: 'bounce-back', run: bounceSuite },
  { name: 'regression', run: regressionSuite },
  { name: 'frontend', run: frontendSuite },
];

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const filter = flag('filter');
const port = Number(flag('port', 4474));

const selected = filter
  ? SUITES.filter((s) => s.name.includes(filter))
  : SUITES;

if (selected.length === 0) {
  console.error(`No suite matched "${filter}". Available: ${SUITES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

console.log(`Running ${selected.length} suite(s) against a throwaway database on port ${port}`);

let server;
try {
  server = await startTestServer({ port });
} catch (err) {
  console.error(`\nCould not start the test server: ${err.message}`);
  process.exit(1);
}

console.log(`  server:  ${server.base}`);
console.log(`  db:      ${server.dbPath}`);
console.log(`  live db: ${server.liveDbPath} (must not be written)`);

setContext({ base: server.base, dbPath: server.dbPath, port });

let totalPassed = 0;
let totalFailed = 0;
let crashed = null;

for (const { name, run } of selected) {
  const t = suite(name);
  try {
    await run(t);
  } catch (err) {
    // A suite that throws is a failure of that suite, not a reason to abandon the
    // rest: the next one may be unaffected, and its result is still information.
    crashed = { name, err };
    t.ok(`${name} suite ran to completion`, false, err.message);
    if (err.stack) console.error(`\n${name} threw:\n${err.stack}\n`);
  }
  totalPassed += t.passed;
  totalFailed += t.report();
}

// The load-bearing check: the real database must be untouched by the whole run.
const { liveDbUnchanged } = await server.stop();
const integrity = suite('integrity');
integrity.ok('the live database was not modified by this run', liveDbUnchanged,
  'fingerprint changed — a test wrote to the real gap.db');
totalFailed += integrity.report();
totalPassed += integrity.passed;

console.log('\n====================================');
console.log(`  total: ${totalPassed} passed, ${totalFailed} failed`);
console.log('====================================');

process.exit(totalFailed === 0 && !crashed ? 0 : 1);
