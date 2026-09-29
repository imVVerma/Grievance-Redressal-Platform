// Regression net for behaviour that predates the bounce-back work: submission
// creation, the public listing, status transitions per role, anonymity,
// redaction, reference data, CORS, and staff sessions.
//
// Every assertion here describes behaviour that existed before the triage
// bounce-back change. If one fails, the change broke something unrelated — which
// is the whole reason this file is separate from bounce.test.mjs.

import {
  STAFF, allJars, call, createSubmission, get, patch, post, uniqueTitle, withHeaders,
} from './lib/harness.mjs';

export default async function run(t) {
  const jars = await allJars();

  // --- creation -----------------------------------------------------------
  t.section('submission creation');

  const madeTitle = uniqueTitle('reg');
  const made = await post('/submissions', {
    submission_type: 'request', title: madeTitle, description: 'regression fixture', department_id: '1',
  });
  t.ok('create returns 201', made.status === 201, made.status);
  t.ok('create returns a 32-character token', /^[0-9a-f]{32}$/.test(made.data.submission_token ?? ''), made.data.submission_token);
  t.ok('create returns the new id', Number.isInteger(made.data.id) && made.data.id > 0, made.data.id);
  // The token is released exactly once, to the submitter. The create response
  // must not become a second read path onto the row.
  t.ok('create leaks no other submission fields',
    ['department_id', 'status', 'created_at', 'submitted_by'].every((k) => !(k in made.data)),
    JSON.stringify(Object.keys(made.data)));

  t.ok('a missing title is rejected', (await post('/submissions', { submission_type: 'request', description: 'd' })).status === 400);
  t.ok('a missing description is rejected', (await post('/submissions', { submission_type: 'request', title: 't' })).status === 400);
  t.ok('a blank title is rejected', (await post('/submissions', { submission_type: 'request', title: '  ', description: 'd' })).status === 400);
  t.ok('an invalid submission_type is rejected', (await post('/submissions', { submission_type: 'nope', title: 't', description: 'd' })).status === 400);
  // Note: only the status-reason is length-capped (MAX_REASON_LENGTH). Title and
  // description have no cap, so this suite deliberately does not assert one —
  // a limit that does not exist cannot be regressed. Flagged as a gap in review
  // rather than enshrined here.

  const anon = await createSubmission({ is_anonymous: true, title: 'reg-anon' });
  t.ok('an anonymous submission is accepted', anon.is_anonymous === 1 || anon.is_anonymous === true, anon.is_anonymous);
  t.ok('...and carries no submitter', anon.submitted_by == null, anon.submitted_by);
  t.ok('...and its default status is submitted', anon.status === 'submitted', anon.status);

  // --- listing and lookup -------------------------------------------------
  t.section('public listing and token lookup');

  const list = await get('/submissions');
  t.ok('the listing is public', list.status === 200, list.status);
  t.ok('the listing is an array', Array.isArray(list.data));
  t.ok('the listing never leaks tokens', list.data.every((s) => !('submission_token' in s)));
  t.ok('the listing never leaks history', list.data.every((s) => !('history' in s)));

  const looked = await get(`/submissions/token/${made.data.submission_token}`);
  t.ok('a token finds its submission', looked.status === 200, looked.status);
  t.ok('the lookup returns the title that was submitted', looked.data.title === madeTitle, looked.data.title);
  t.ok('the lookup includes history', Array.isArray(looked.data.history) && looked.data.history.length >= 1);
  t.ok('history is oldest-first', looked.data.history.every((h, i) => i === 0 || looked.data.history[i - 1].changed_at <= h.changed_at));
  t.ok('history entries carry a reason', looked.data.history.every((h) => typeof h.reason === 'string'));
  t.ok('history never exposes who acted', looked.data.history.every((h) => !('changed_by' in h)));
  t.ok('an unknown token is 404', (await get('/submissions/token/deadbeef')).status === 404);
  t.ok('a malformed token is 404', (await get('/submissions/token/not-a-token')).status === 404);
  t.ok('an empty token is 404', (await get('/submissions/token/')).status === 404);

  // --- transitions --------------------------------------------------------
  t.section('status transitions by role');

  const s = await createSubmission({ department_id: '1', title: 'reg-transitions' });
  const id = s.submission_id;
  const to = (status, reason, jar) => patch(`/submissions/${id}/status`, { new_status: status, reason }, jar);

  t.ok('an anonymous caller cannot advance', (await to('acknowledged', 'x', undefined)).status === 401);
  t.ok('department staff advances its own row', (await to('acknowledged', 'ack', jars.dept)).status === 200);
  t.ok('skipping a step is refused', (await to('resolved', 'skip', jars.dept)).status === 400);
  t.ok('triage cannot advance', (await to('in_progress', 'x', jars.triage)).status === 403);
  t.ok('council cannot advance mid-flow', (await to('in_progress', 'x', jars.council)).status === 403);
  t.ok('department staff continues its own row', (await to('in_progress', 'work', jars.dept)).status === 200);
  t.ok('department staff can escalate', (await to('pending_council_review', 'escalate', jars.dept)).status === 200);
  t.ok('a reason is required', (await to('resolved', '   ', jars.dept)).status === 400);
  t.ok('a 256-character reason is refused', (await to('resolved', 'x'.repeat(256), jars.dept)).status === 400);
  t.ok('a 255-character reason is accepted', (await to('resolved', 'x'.repeat(255), jars.dept)).status === 200);
  t.ok('department staff cannot close', (await to('closed', 'done', jars.dept)).status === 403);
  t.ok('council can close', (await to('closed', 'approved', jars.council)).status === 200);
  t.ok('a closed row cannot move again', (await to('resolved', 'reopen', jars.admin)).status === 400);
  t.ok('an unknown status value is refused', (await to('teleported', 'x', jars.admin)).status === 400);
  t.ok('a missing submission is 404', (await patch('/submissions/999999/status', { new_status: 'acknowledged', reason: 'x' }, jars.admin)).status === 404);
  t.ok('a non-integer id is 400', (await call('PATCH', '/submissions/abc/status', { new_status: 'acknowledged', reason: 'x' }, jars.admin)).status === 400);

  const foreign = await createSubmission({ department_id: '3', title: 'reg-foreign' });
  t.ok('department staff cannot touch another department',
    (await patch(`/submissions/${foreign.submission_id}/status`, { new_status: 'acknowledged', reason: 'x' }, jars.dept)).status === 403);
  t.ok('admin can advance any department',
    (await patch(`/submissions/${foreign.submission_id}/status`, { new_status: 'acknowledged', reason: 'x' }, jars.admin)).status === 200);

  // --- anonymity and timestamps ------------------------------------------
  t.section('anonymity and timestamps');

  const anonRow = await createSubmission({ is_anonymous: true, department_id: '1', title: 'reg-anon-lookup' });
  const anonSeen = await get(`/submissions/token/${anonRow.submission_token}`);
  t.ok('an anonymous lookup hides the submitter', anonSeen.data.submitted_by == null, anonSeen.data.submitted_by);
  t.ok('anonymous timestamps are bucketed to the hour',
    anonSeen.data.history.every((h) => /T\d{2}:00:00Z$/.test(h.changed_at)),
    JSON.stringify(anonSeen.data.history.map((h) => h.changed_at)));
  t.ok('anonymous created_at is bucketed too', /T\d{2}:00:00Z$/.test(anonSeen.data.created_at), anonSeen.data.created_at);
  t.ok('no submitted_by id is serialised for an anonymous row',
    !JSON.stringify(anonSeen.data).includes('"submitted_by":"'));

  const named = await createSubmission({ department_id: '1', title: 'reg-named' });
  const namedSeen = await get(`/submissions/token/${named.submission_token}`);
  t.ok('a known submitter keeps second-level timestamps',
    namedSeen.data.history.every((h) => /T\d{2}:\d{2}:\d{2}Z$/.test(h.changed_at)),
    JSON.stringify(namedSeen.data.history.map((h) => h.changed_at)));
  t.ok('every timestamp is UTC-Z', [anonSeen, namedSeen].every((x) => x.data.created_at.endsWith('Z')));

  // --- redaction ----------------------------------------------------------
  t.section('redaction');

  const preview = await post('/submissions/redact-preview', {
    title: 'Contact me at a@b.com', description: 'Call 9876543210 about room 415.',
  });
  t.ok('the preview is public', preview.status === 200, preview.status);
  t.ok('the preview returns only the masked fields and a count',
    JSON.stringify(Object.keys(preview.data).sort()) === JSON.stringify(['flaggedCount', 'redactedDescription', 'redactedTitle']),
    JSON.stringify(Object.keys(preview.data)));
  t.ok('an email address is masked in the title', !preview.data.redactedTitle.includes('a@b.com'), preview.data.redactedTitle);
  t.ok('the count reflects the detection', preview.data.flaggedCount >= 1, preview.data.flaggedCount);
  t.ok('the detected value is never echoed back', !JSON.stringify(preview.data).includes('a@b.com'));
  // redact.js scopes itself to email addresses on purpose, so a phone number
  // surviving is the documented behaviour, not a gap to assert away.
  t.ok('a phone number is deliberately left alone', preview.data.redactedDescription.includes('9876543210'), preview.data.redactedDescription);
  t.ok('an empty body is accepted', (await post('/submissions/redact-preview', {})).status === 200);
  t.ok('a non-string title is rejected', (await post('/submissions/redact-preview', { title: 42 })).status === 400);

  const named2 = await post('/submissions/redact-preview', {
    title: 'My name is Priya Kumar', description: 'Priya Kumar said the door is jammed and Priya Kumar will confirm.',
  });
  t.ok('a person name is masked', named2.data.redactedTitle.includes('[REDACTED]') && !named2.data.redactedTitle.includes('Priya'), named2.data.redactedTitle);
  t.ok('every occurrence of the name is masked, not just the first',
    !named2.data.redactedDescription.includes('Priya') && (named2.data.redactedDescription.match(/\[REDACTED\]/g) ?? []).length === 2,
    named2.data.redactedDescription);
  // The false-positive guard is the thing that makes redaction usable at all:
  // a submission is mostly department names, place names and room numbers.
  for (const safe of ['Hostel Maintenance', 'The Mess Committee is responsible', 'Room 415 is dirty', 'Water is cold in Hostel 2']) {
    const r = await post('/submissions/redact-preview', { title: safe });
    t.ok(`"${safe}" is not over-masked`, r.data.redactedTitle === safe && r.data.flaggedCount === 0, r.data.redactedTitle);
  }

  // Redaction is enforced by the server on the way in, whatever the client did.
  const sneaky = await post('/submissions', {
    submission_type: 'request', title: 'Email me at a@b.com', description: 'My name is Priya Kumar',
  });
  const sneakySeen = await get(`/submissions/token/${sneaky.data.submission_token}`);
  t.ok('the stored title is masked even without a preview', !sneakySeen.data.title.includes('a@b.com'), sneakySeen.data.title);
  t.ok('the stored description is masked even without a preview', !sneakySeen.data.description.includes('Priya'), sneakySeen.data.description);
  t.ok('create reports that it redacted', sneaky.data.redacted === true, sneaky.data.redacted);

  const clean = await post('/submissions', {
    submission_type: 'request', title: 'The water is cold', description: 'Drinking fountain is broken',
  });
  t.ok('create does not claim redaction when there was none', clean.data.redacted === false, clean.data.redacted);

  // --- reference data -----------------------------------------------------
  t.section('reference data');

  const departments = await get('/departments');
  t.ok('departments is public', departments.status === 200, departments.status);
  t.ok('departments expose exactly id, name and description',
    departments.data.every((x) => Object.keys(x).sort().join(',') === 'department_id,description,name'),
    JSON.stringify(Object.keys(departments.data[0] ?? {})));
  t.ok('department ids are unique', new Set(departments.data.map((x) => x.department_id)).size === departments.data.length);
  t.ok('departments are ordered by id',
    departments.data.every((x, i) => i === 0 || departments.data[i - 1].department_id <= x.department_id));

  const categories = await get('/categories');
  t.ok('categories is public', categories.status === 200, categories.status);
  t.ok('categories expose exactly id, name, submission_type and department_id',
    categories.data.every((x) => Object.keys(x).sort().join(',') === 'category_id,department_id,name,submission_type'),
    JSON.stringify(Object.keys(categories.data[0] ?? {})));
  t.ok('category ids are unique', new Set(categories.data.map((x) => x.category_id)).size === categories.data.length);
  t.ok('every category carries a submission_type field', categories.data.every((x) => 'submission_type' in x));

  // --- CORS ---------------------------------------------------------------
  t.section('CORS and credentials');

  const restore = withHeaders({ Origin: 'http://localhost:5173' });
  const allowed = await get('/submissions');
  t.ok('an allowed origin is echoed back', allowed.headers.get('access-control-allow-origin') === 'http://localhost:5173',
    allowed.headers.get('access-control-allow-origin'));
  t.ok('credentials are permitted', allowed.headers.get('access-control-allow-credentials') === 'true');
  restore();

  const evil = await call('GET', '/submissions', undefined, undefined);
  t.ok('no Origin header means no CORS grant', evil.headers.get('access-control-allow-origin') === null,
    evil.headers.get('access-control-allow-origin'));

  const foreignRestore = withHeaders({ Origin: 'http://evil.example' });
  const foreignOrigin = await get('/submissions');
  t.ok('an unlisted origin is not echoed', foreignOrigin.headers.get('access-control-allow-origin') === null,
    foreignOrigin.headers.get('access-control-allow-origin'));
  const foreignWrite = await post('/submissions', { submission_type: 'request', title: 'x', description: 'y' });
  t.ok('an unlisted origin gets no grant on a write either', foreignWrite.headers.get('access-control-allow-origin') === null);
  foreignRestore();

  // --- sessions -----------------------------------------------------------
  t.section('staff sessions');

  const me = await get('/staff/me', jars.dept);
  t.ok('a session resolves to its staff member', me.status === 200, me.status);
  t.ok('it reports the role', me.data.role === 'department_staff', me.data.role);
  t.ok('it reports the department', String(me.data.department_id) === '1', me.data.department_id);
  t.ok('no cookie means signed out, not 401', (await get('/staff/me')).status === 200);
  t.ok('a signed-out session reports a null role', (await get('/staff/me')).data.role === null);
  t.ok('a forged cookie is signed out', (await get('/staff/me', 'gap.sid=forged')).data.role === null);
  t.ok('a bad password is rejected', (await post('/staff/login', { email: STAFF.dept.email, password: 'wrong' })).status === 401);
  t.ok('an unknown email is rejected', (await post('/staff/login', { email: 'nobody@uni.edu', password: STAFF.dept.password })).status === 401);
  // Login answers every failure the same way on purpose: a form that says
  // "no such account" is an account-existence oracle. A missing password is
  // just another failure, not a different class of one.
  const wrongPassword = await post('/staff/login', { email: STAFF.dept.email, password: 'wrong' });
  const noPassword = await post('/staff/login', { email: STAFF.dept.email });
  const noSuchUser = await post('/staff/login', { email: 'nobody@uni.edu', password: 'wrong' });
  t.ok('a missing password is rejected the same way as a wrong one',
    noPassword.status === wrongPassword.status && noPassword.data.error === wrongPassword.data.error,
    `${noPassword.status}/${noPassword.data.error} vs ${wrongPassword.status}/${wrongPassword.data.error}`);
  t.ok('an unknown account is indistinguishable from a wrong password',
    noSuchUser.status === wrongPassword.status && noSuchUser.data.error === wrongPassword.data.error,
    `${noSuchUser.data.error} vs ${wrongPassword.data.error}`);
  t.ok('the error text does not echo the submitted email', !JSON.stringify(wrongPassword.data).includes(STAFF.dept.email));
  t.ok('the password is never echoed back', !JSON.stringify(me.data).includes(STAFF.dept.password));

  const throwaway = await allJars();
  t.ok('logout succeeds', (await post('/staff/logout', {}, throwaway.triage)).status === 200);
  t.ok('the session is dead after logout', (await get('/staff/me', throwaway.triage)).data.role === null);

  // --- identity map -------------------------------------------------------
  t.section('identity map stays admin-only');

  t.ok('an anonymous caller cannot read it', (await get('/submissions/1/identity')).status === 401);
  t.ok('department staff cannot read it', (await get('/submissions/1/identity', jars.dept)).status === 403);
  t.ok('council cannot read it', (await get('/submissions/1/identity', jars.council)).status === 403);
  t.ok('triage cannot read it', (await get('/submissions/1/identity', jars.triage)).status === 403);
  t.ok('admin can', (await get('/submissions/1/identity', jars.admin)).status === 200);
}
