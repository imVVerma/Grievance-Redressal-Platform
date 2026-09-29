# Tests

```
cd backend && npm test                 # everything
cd backend && npm test -- --filter bounce   # one suite
cd backend && npm test -- --port 4480  # if 4474 is taken
```

Exits non-zero on any failure, so it drops straight into CI.

## How it stays out of the real database

`db.js` opens `GAP_DB_PATH` when that variable is set, and otherwise the
`gap.db` beside it, which is the live grievance data. The runner always sets
`GAP_DB_PATH` to a throwaway copy in a temp directory, so a test cannot reach
the real rows even by accident — there is no path from the test server to that
file.

`run.mjs` then fingerprints every row of every table in the live database before
and after the run and fails if it changed. That check is the backstop for the
mechanism above; it is worth keeping, because "the tests were careful" is not a
boundary, a missing `GAP_DB_PATH` assignment is.

Never point `GAP_DB_PATH` at `backend/gap.db`.

## Layout

| File | Covers |
|---|---|
| `run.mjs` | Starts the server, runs each suite, tears down, checks the live DB |
| `lib/harness.mjs` | Assertions, HTTP helpers, fixtures, read-only DB access |
| `lib/server.mjs` | Test server lifecycle and the live-DB fingerprint |
| `bounce.test.mjs` | Triage bounce-back: scoping, validation, audit trail, timeline |
| `regression.test.mjs` | Everything that predates bounce-back |
| `frontend.test.mjs` | Components rendered for real, hitting the test server |

## Adding a test

New behaviour goes in `bounce.test.mjs`, or a new file if it is a distinct
area. A new file is one default export plus one line in `SUITES` in `run.mjs`:

```js
import { createSubmission, get, post } from './lib/harness.mjs';

export default async function run(t) {
  t.section('what this covers');
  const row = await createSubmission({ department_id: '1' });
  const res = await post(`/submissions/${row.submission_id}/bounce`, { reason: 'not ours' });
  t.ok('it bounced', res.status === 200, res.status);
}
```

`t.ok(label, condition, detail)` only prints `detail` on failure, so passing
output stays readable. Throw instead of asserting if a precondition is missing —
`run.mjs` catches it, fails that suite, and still runs the rest.

## Things to know before writing assertions

These cost real time to discover, and the code is the source of truth:

- `POST /submissions` returns `{ id, message, submission_token, redacted }` —
  not the row. Use `createSubmission()` to get a full row.
- There is no `GET /submissions/:id`; the SPA catch-all answers it with HTML.
  Use `rowById()`, which filters the public listing.
- `GET /departments` returns 3 fields, `GET /categories` returns 4.
- `redact.js` handles email addresses and person names only. Phone numbers are
  left alone on purpose, and department names must not be over-masked.
- Login answers every failure with one 401 on purpose, so the form is not an
  account-existence oracle.
- Only the status reason has a length cap (`MAX_REASON_LENGTH`).

Assert the behaviour the code has, not the behaviour you expected. Roughly a
third of the first version of these suites was wrong about the contract, and
every one of those wrong assertions had to be un-learned before the real bugs
could be seen.
