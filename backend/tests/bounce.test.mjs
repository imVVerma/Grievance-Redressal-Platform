// Triage bounce-back: role scoping, validation, the audit trail, and the merged
// token-lookup timeline.
//
// The invariants worth protecting here, in order of how badly they would hurt
// if they broke:
//   1. A department can only bounce its own rows, and only while it holds them.
//   2. A row that has no department is triage's to route, and nobody else's.
//   3. Bouncing and reassigning never move the workflow status.
//   4. The timeline is chronological, typed, and free of raw ids.

import {
  STAFF, allJars, call, createSubmission, get, post, readDb, writeDb,
} from './lib/harness.mjs';

export default async function run(t) {
  const jars = await allJars();
  const db = readDb();

  const bounce = (id, reason, jar) => post(`/submissions/${id}/bounce`, { reason }, jar);
  const reassign = (id, department_id, reason, jar) =>
    post(`/submissions/${id}/reassign`, { department_id, reason }, jar);

  const deptOf = (id) =>
    db.prepare('SELECT department_id FROM submissions WHERE submission_id = ?').get(id)?.department_id ?? null;
  const statusOf = (id) =>
    db.prepare('SELECT status FROM submissions WHERE submission_id = ?').get(id)?.status;
  const rows = (id) =>
    db.prepare('SELECT * FROM reassignment_history WHERE submission_id = ? ORDER BY history_id').all(id);
  const userId = (email) =>
    db.prepare('SELECT user_id FROM users WHERE email = ?').get(email)?.user_id;

  // --- bouncing -----------------------------------------------------------
  t.section('department staff bounces its own department');

  const own = await createSubmission({ department_id: '1', title: 'bounce-own' });
  const statusBefore = statusOf(own.submission_id);
  const staffId = userId(STAFF.dept.email);

  const b1 = await bounce(own.submission_id, 'This is a mess issue, not maintenance.', jars.dept);
  t.ok('bounce succeeds with 200', b1.status === 200, `${b1.status} ${JSON.stringify(b1.data)}`);
  t.ok('the response reports a null department', b1.data?.department_id === null, b1.data?.department_id);
  t.ok('the response does not hand back the token', !('submission_token' in (b1.data ?? {})));
  t.ok('the stored department is NULL', deptOf(own.submission_id) === null, deptOf(own.submission_id));
  t.ok('exactly one audit row was written', rows(own.submission_id).length === 1, rows(own.submission_id).length);

  const audit = rows(own.submission_id)[0];
  t.ok('the audit row records the old department', audit.old_department_id === 1, audit.old_department_id);
  t.ok('the audit row records a null new department', audit.new_department_id === null, audit.new_department_id);
  t.ok('the audit row records the reason', audit.reason === 'This is a mess issue, not maintenance.');
  t.ok('the audit row records who acted', audit.changed_by === staffId, audit.changed_by);
  t.ok('the audit row is timestamped', Boolean(audit.changed_at));
  t.ok('bouncing does not change the workflow status', statusOf(own.submission_id) === statusBefore,
    `${statusBefore} -> ${statusOf(own.submission_id)}`);

  // --- scoping and role gates --------------------------------------------
  t.section('scoping and role gates');

  const other = await createSubmission({ department_id: '3', title: 'bounce-other' });
  t.ok('a department cannot bounce another department', (await bounce(other.submission_id, 'not ours', jars.dept)).status === 403);
  t.ok('...and the row is untouched', deptOf(other.submission_id) === 3, deptOf(other.submission_id));
  t.ok('...with no audit row', rows(other.submission_id).length === 0);

  t.ok('triage cannot bounce (the role lists do not overlap)', (await bounce(own.submission_id, 'try', jars.triage)).status === 403);
  t.ok('council cannot bounce', (await bounce(other.submission_id, 'try', jars.council)).status === 403);
  t.ok('an anonymous bounce is 401', (await bounce(own.submission_id, 'try', undefined)).status === 401);
  t.ok('an anonymous reassign is 401', (await reassign(own.submission_id, 2, 'try', undefined)).status === 401);
  t.ok('department staff cannot reassign', (await reassign(own.submission_id, 2, 'try', jars.dept)).status === 403);
  t.ok('council cannot reassign', (await reassign(own.submission_id, 2, 'try', jars.council)).status === 403);

  const forged = await call('POST', `/submissions/${own.submission_id}/bounce`, { reason: 'forged' }, 'gap.sid=forged');
  t.ok('a forged session cookie is 401', forged.status === 401, forged.status);
  const missing = await call('POST', `/submissions/${own.submission_id}/bounce`, { reason: 'x' }, 'gap.sid=does-not-exist');
  t.ok('an invented session cookie is 401', missing.status === 401, missing.status);

  const adminBounce = await bounce(other.submission_id, 'routed wrongly, returning it', jars.admin);
  t.ok('admin can bounce across departments', adminBounce.status === 200, adminBounce.status);
  t.ok('...which clears the department', deptOf(other.submission_id) === null, deptOf(other.submission_id));

  // --- reassigning --------------------------------------------------------
  t.section('triage reassigns');

  const r1 = await reassign(own.submission_id, 2, 'Mess Committee should take this.', jars.triage);
  t.ok('reassign succeeds with 200', r1.status === 200, `${r1.status} ${JSON.stringify(r1.data)}`);
  t.ok('the response carries the new department', String(r1.data?.department_id) === '2', r1.data?.department_id);
  t.ok('the stored department is updated', String(deptOf(own.submission_id)) === '2', deptOf(own.submission_id));
  t.ok('a second audit row was written', rows(own.submission_id).length === 2, rows(own.submission_id).length);

  const audit2 = rows(own.submission_id)[1];
  t.ok('it records a null old department', audit2.old_department_id === null, audit2.old_department_id);
  t.ok('it records the new department', audit2.new_department_id === 2, audit2.new_department_id);
  t.ok('it records the reason', audit2.reason === 'Mess Committee should take this.');
  t.ok('it records who acted', audit2.changed_by === userId(STAFF.triage.email), audit2.changed_by);
  t.ok('the status is still untouched after the full round trip', statusOf(own.submission_id) === statusBefore);

  // The "bounce first" rule has to hold for admin too, or it is a UI habit
  // rather than an invariant.
  t.ok('admin cannot reassign an already-assigned row either',
    (await reassign(own.submission_id, 3, 'override', jars.admin)).status === 400);
  t.ok('...and the department is unchanged', String(deptOf(own.submission_id)) === '2', deptOf(own.submission_id));
  t.ok('...with no extra audit row', rows(own.submission_id).length === 2, rows(own.submission_id).length);

  const adminOwn = await createSubmission({ department_id: '1', title: 'admin-round-trip' });
  t.ok('admin can bounce', (await bounce(adminOwn.submission_id, 'not ours either', jars.admin)).status === 200);
  t.ok('admin can then reassign', (await reassign(adminOwn.submission_id, 3, 'admin routes it', jars.admin)).status === 200);
  t.ok('...to the department admin chose', String(deptOf(adminOwn.submission_id)) === '3', deptOf(adminOwn.submission_id));

  // --- validation ---------------------------------------------------------
  t.section('validation');

  const v = await createSubmission({ department_id: '1', title: 'bounce-validate' });
  const id = v.submission_id;
  t.ok('a blank reason is rejected', (await bounce(id, '   ', jars.dept)).status === 400);
  t.ok('a missing reason is rejected', (await bounce(id, undefined, jars.dept)).status === 400);
  t.ok('a 256-character reason is rejected', (await bounce(id, 'x'.repeat(256), jars.dept)).status === 400);
  t.ok('a 255-character reason is accepted', (await bounce(id, 'x'.repeat(255), jars.dept)).status === 200);
  t.ok('bouncing an already-unassigned row is rejected', (await bounce(id, 'again', jars.admin)).status === 400);
  t.ok('reassign without a department is rejected', (await reassign(id, undefined, 'r', jars.triage)).status === 400);
  t.ok('reassign with a null department is rejected', (await reassign(id, null, 'r', jars.triage)).status === 400);
  t.ok('reassign with a non-numeric department is rejected', (await reassign(id, 'mess', 'r', jars.triage)).status === 400);
  t.ok('reassign with an unknown department is rejected', (await reassign(id, 9999, 'r', jars.triage)).status === 400);
  t.ok('reassign with a negative department is rejected', (await reassign(id, -1, 'r', jars.triage)).status === 400);
  t.ok('reassign with a 256-character reason is rejected', (await reassign(id, 1, 'y'.repeat(256), jars.triage)).status === 400);
  t.ok('bouncing a missing submission is 404', (await bounce(999999, 'gone', jars.admin)).status === 404);
  t.ok('reassigning a missing submission is 404', (await reassign(999999, 1, 'gone', jars.triage)).status === 404);
  t.ok('a non-integer id is 400', (await call('POST', '/submissions/abc/bounce', { reason: 'x' }, jars.admin)).status === 400);

  // --- timeline -----------------------------------------------------------
  t.section('merged token-lookup timeline');

  const s = await createSubmission({ department_id: '1', title: 'bounce-timeline' });
  const tok = s.submission_token;
  await call('PATCH', `/submissions/${s.submission_id}/status`, { new_status: 'acknowledged', reason: 'seen' }, jars.dept);
  await bounce(s.submission_id, 'not ours', jars.dept);
  await reassign(s.submission_id, 2, 'mess committee please', jars.triage);
  await call('PATCH', `/submissions/${s.submission_id}/status`, { new_status: 'in_progress', reason: 'work started' }, jars.admin);

  // All five events land inside one wall-clock second, so the clock cannot be
  // trusted to order them. Pin them to a known increasing sequence instead: that
  // is the case the merge actually has to get right, and it also proves the
  // reassignments interleave rather than pile up at the end.
  const order = ['Initial submission via API', 'seen', 'not ours', 'mess committee please', 'work started'];
  const w = writeDb();
  order.forEach((reason, i) => {
    const stamp = `2026-01-01 10:0${i}:00`;
    const updated = w.prepare('UPDATE status_history SET changed_at = ? WHERE submission_id = ? AND reason = ?')
      .run(stamp, s.submission_id, reason);
    if (updated.changes === 0) {
      w.prepare('UPDATE reassignment_history SET changed_at = ? WHERE submission_id = ? AND reason = ?')
        .run(stamp, s.submission_id, reason);
    }
  });
  w.close();

  const seen = await get(`/submissions/token/${tok}`);
  const hist = seen.data.history;
  t.ok('every event appears, including the one creation adds', hist.length === 5,
    `${hist.length}: ${JSON.stringify(hist.map((h) => h.reason))}`);
  t.ok('every entry is typed', hist.every((h) => h.type === 'status' || h.type === 'reassignment'));
  t.ok('the types are 3 status and 2 reassignment',
    hist.filter((h) => h.type === 'status').length === 3 && hist.filter((h) => h.type === 'reassignment').length === 2,
    JSON.stringify(hist.map((h) => h.type)));
  t.ok('entries are in the pinned chronological order',
    JSON.stringify(hist.map((h) => h.reason)) === JSON.stringify(order),
    JSON.stringify(hist.map((h) => h.reason)));
  t.ok('reassignments interleave between statuses instead of being appended',
    hist.findIndex((h) => h.type === 'reassignment') === 2,
    JSON.stringify(hist.map((h) => h.type)));
  t.ok('timestamps are non-decreasing', hist.every((h, i) => i === 0 || hist[i - 1].changed_at <= h.changed_at));
  t.ok('timestamps are UTC-Z', hist.every((h) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(h.changed_at)));

  const bounced = hist[2];
  const routed = hist[3];
  t.ok('a bounce resolves the old department to a name', bounced.old_department === 'Hostel Maintenance', bounced.old_department);
  t.ok('a bounce renders the new department as Unassigned', bounced.new_department === 'Unassigned', bounced.new_department);
  t.ok('a bounce carries no raw ids',
    !('old_department_id' in bounced) && !('new_department_id' in bounced), JSON.stringify(Object.keys(bounced)));
  t.ok('a reassign renders the old department as Unassigned', routed.old_department === 'Unassigned', routed.old_department);
  t.ok('a reassign resolves the new department to a name', routed.new_department === 'Mess Committee', routed.new_department);
  t.ok('a reassign carries no raw ids', !('new_department_id' in routed));
  t.ok('status entries still carry their statuses',
    hist.filter((h) => h.type === 'status').every((h) => h.new_status && 'old_status' in h));
  t.ok('status entries carry no department fields',
    hist.filter((h) => h.type === 'status').every((h) => !('old_department' in h)));
  t.ok('the acting user never leaks into the timeline', !JSON.stringify(hist).includes('changed_by'));

  const orders = new Set();
  for (let i = 0; i < 6; i++) {
    const again = await get(`/submissions/token/${tok}`);
    orders.add(JSON.stringify(again.data.history.map((h) => `${h.type}:${h.reason}`)));
  }
  t.ok('the order is stable across repeat calls', orders.size === 1, `${orders.size} distinct orders`);

  // Anonymity still applies to the merged timeline, and bucketing still works
  // when the entries come from two different tables.
  const anon = await createSubmission({ is_anonymous: true, department_id: '1', title: 'bounce-anon' });
  await bounce(anon.submission_id, 'not ours', jars.dept);
  await reassign(anon.submission_id, 3, 'academic please', jars.triage);
  const anonSeen = await get(`/submissions/token/${anon.submission_token}`);
  t.ok('an anonymous timeline merges both types', anonSeen.data.history.length === 3, anonSeen.data.history.length);
  t.ok('anonymous reassignment timestamps are bucketed to the hour',
    anonSeen.data.history.every((h) => /T\d{2}:00:00Z$/.test(h.changed_at)),
    JSON.stringify(anonSeen.data.history.map((h) => h.changed_at)));
  t.ok('anonymous reassignments still show department names',
    anonSeen.data.history.some((h) => h.old_department === 'Hostel Maintenance') &&
    anonSeen.data.history.some((h) => h.new_department === 'Academic Office'));

  // --- determinism --------------------------------------------------------
  t.section('same-second ordering is deterministic');

  // Forced rather than hoped for: the documented tiebreak should be exercised,
  // not merely asserted.
  const tie = await createSubmission({ department_id: '1', title: 'bounce-tie' });
  const stamp = '2026-01-01 12:00:00';
  const wt = writeDb();
  wt.prepare('UPDATE submissions SET updated_at = ? WHERE submission_id = ?').run(stamp, tie.submission_id);
  wt.prepare(
    "INSERT INTO status_history (submission_id, old_status, new_status, reason, changed_at) VALUES (?, 'submitted', 'acknowledged', 'tie status', ?)"
  ).run(tie.submission_id, stamp);
  wt.prepare(
    'INSERT INTO reassignment_history (submission_id, old_department_id, new_department_id, reason, changed_at) VALUES (?, 1, NULL, ?, ?)'
  ).run(tie.submission_id, 'tie bounce', stamp);
  wt.close();

  const tied = (await get(`/submissions/token/${tie.submission_token}`)).data.history;
  const statusAt = tied.findIndex((h) => h.reason === 'tie status');
  const bounceAt = tied.findIndex((h) => h.reason === 'tie bounce');
  t.ok('both colliding entries are present', statusAt >= 0 && bounceAt >= 0, `${statusAt}, ${bounceAt}`);
  t.ok('the documented tiebreak puts status first', statusAt < bounceAt, `${statusAt} vs ${bounceAt}`);

  const tieOrders = new Set();
  for (let i = 0; i < 8; i++) {
    const again = await get(`/submissions/token/${tie.submission_token}`);
    tieOrders.add(JSON.stringify(again.data.history.map((h) => h.reason)));
  }
  t.ok('the collision resolves identically on every call', tieOrders.size === 1, `${tieOrders.size} distinct orders`);

  // --- schema -------------------------------------------------------------
  t.section('schema');

  const cols = db.prepare('PRAGMA table_info(reassignment_history)').all().map((c) => c.name);
  t.ok('the table has exactly the specified columns',
    JSON.stringify(cols) === JSON.stringify(['history_id', 'submission_id', 'old_department_id', 'new_department_id', 'reason', 'changed_by', 'changed_at']),
    JSON.stringify(cols));
  t.ok('status_history was not given new columns',
    JSON.stringify(db.prepare('PRAGMA table_info(status_history)').all().map((c) => c.name)) ===
    JSON.stringify(['history_id', 'submission_id', 'old_status', 'new_status', 'changed_by', 'reason', 'changed_at']));

  const fks = db.prepare('PRAGMA foreign_key_list(reassignment_history)').all();
  const byColumn = Object.fromEntries(fks.map((f) => [f.from, f.on_delete]));
  t.ok('audit rows cascade when a submission is deleted', byColumn.submission_id === 'CASCADE', byColumn.submission_id);
  t.ok('the department and user references are not cascaded away',
    byColumn.old_department_id !== 'CASCADE' && byColumn.new_department_id !== 'CASCADE' && byColumn.changed_by !== 'CASCADE',
    JSON.stringify(byColumn));

  const doomed = await createSubmission({ department_id: '1', title: 'bounce-cascade' });
  await bounce(doomed.submission_id, 'bounce for cascade', jars.dept);
  t.ok('the audit row exists before the delete', rows(doomed.submission_id).length === 1);
  const wc = writeDb();
  wc.prepare('DELETE FROM submissions WHERE submission_id = ?').run(doomed.submission_id);
  t.ok('deleting the submission removes its audit rows',
    wc.prepare('SELECT COUNT(*) c FROM reassignment_history WHERE submission_id = ?').get(doomed.submission_id).c === 0);
  wc.close();

  db.close();
}
