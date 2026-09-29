// Frontend behaviour for the triage bounce-back, rendered for real.
//
// Nothing here is mocked: the components are the actual source files, loaded
// through Vite, and every request they make goes over HTTP to the throwaway
// test server. So a change to a URL, a method or a payload shape in api.js fails
// this suite rather than silently drifting from the backend.
//
// This file lives under backend/tests/ because that is where the test server
// lives, but the components and their tooling belong to the frontend package —
// hence the explicit resolution of vite/react/jsdom against
// frontend/package.json below. Declaring jsdom there as a devDependency keeps
// `npm ci` in frontend/ from quietly removing it.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allJars, createSubmission, rowById } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(here, '..');
const REPO_DIR = join(BACKEND_DIR, '..');
const FRONTEND_DIR = join(REPO_DIR, 'frontend');

const frontendRequire = createRequire(join(FRONTEND_DIR, 'package.json'));
/** Resolve a frontend dependency and import it, with a message that says what to do. */
async function fromFrontend(name) {
  try {
    return await import(frontendRequire.resolve(name));
  } catch (err) {
    throw new Error(
      `frontend suite needs "${name}" from ${FRONTEND_DIR}. Run: (cd frontend && npm install)`,
      { cause: err },
    );
  }
}

export default async function run(t) {
  const { createServer } = await fromFrontend('vite');
  const { JSDOM } = await fromFrontend('jsdom');
  const React = (await fromFrontend('react')).default;
  const { act } = await fromFrontend('react');
  const ReactDOMClient = await fromFrontend('react-dom/client');
  const { base } = (await import('./lib/harness.mjs')).ctx();

  const jars = await allJars();
  const runId = `${process.pid}-${Math.floor(performance.now())}`;
  const T = (name) => `${name}-${runId}`;

  const vite = await createServer({
    root: FRONTEND_DIR,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });

  // Node's global fetch has no cookie jar, and jsdom's window has no fetch at
  // all, so the component under test would talk to the live server with no
  // session. Two rewrites fix that: URLs are pointed at the test server, and the
  // current viewer's session cookie is attached, which is what the browser's
  // `credentials: include` would have done.
  let currentJar = '';
  const nativeFetch = globalThis.fetch;
  const LIVE = 'http://localhost:4000';
  global.fetch = (input, init) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(LIVE)) url = base + url.slice(LIVE.length);
    else if (url.startsWith('/')) url = base + url;
    const headers = { ...init?.headers };
    if (currentJar && !headers.Cookie && !headers.cookie) headers.Cookie = currentJar;
    return nativeFetch(url, { ...init, headers });
  };

  const previous = {
    window: global.window, document: global.document, navigator: global.navigator,
    HTMLElement: global.HTMLElement, Event: global.Event, FormData: global.FormData,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  // Node's navigator is a getter-only global, so plain assignment throws.
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.HTMLElement = dom.window.HTMLElement;
  global.Event = dom.window.Event;
  global.FormData = dom.window.FormData;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = (p) => vite.ssrLoadModule(p);
  const { default: SubmissionList } = await load('/src/SubmissionList.jsx');
  const { TrackResult } = await load('/src/TrackSubmission.jsx');
  const { lookupSubmissionByToken } = await load('/src/api.js');

  const jarFor = (staff) => {
    if (!staff) return '';
    if (staff.role === 'department_staff') return jars.dept;
    if (staff.role === 'triage') return jars.triage;
    if (staff.role === 'council') return jars.council;
    if (staff.role === 'admin') return jars.admin;
    return '';
  };

  /** Render SubmissionList as `staff` and return handles onto the live DOM. */
  async function renderList(staff) {
    currentJar = jarFor(staff);
    const host = dom.window.document.getElementById('root');
    host.innerHTML = '';
    const root = ReactDOMClient.createRoot(host);
    await act(async () => {
      root.render(React.createElement(SubmissionList, { refreshKey: 0, session: staff }));
    });
    await act(async () => { await sleep(300); });

    const cards = () => [...host.querySelectorAll('.list-item')];
    const cardTitled = (title) => cards().find((c) => c.textContent.includes(title));

    return {
      host,
      cards,
      cardTitled,
      text: () => host.textContent,
      q: (sel) => host.querySelector(sel),
      qa: (sel) => [...host.querySelectorAll(sel)],
      async click(el) {
        await act(async () => { el.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
        await act(async () => { await sleep(300); });
      },
      async choose(el, value) {
        await act(async () => {
          el.value = value;
          el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        });
      },
      async unmount() { await act(async () => { root.unmount(); }); },
    };
  }

  try {
    // --- department staff ------------------------------------------------
    t.section('department staff sees the bounce action on its own row');

    const mine = await createSubmission({ department_id: '1', title: T('BounceMe') });
    await createSubmission({ department_id: '3', title: T('NotMine') });
    const unassigned = await createSubmission({ title: T('Unassigned') });

    {
      const v = await renderList({ role: 'department_staff', department_id: 1 });
      const myCard = v.cardTitled(T('BounceMe'));
      const otherCard = v.cardTitled(T('NotMine'));
      const unCard = v.cardTitled(T('Unassigned'));

      t.ok('the bounce button shows on its own row', myCard?.textContent.includes('Not our department'),
        myCard?.textContent.slice(0, 100));
      t.ok('it is hidden on another department', !otherCard?.textContent.includes('Not our department'));
      t.ok('it is hidden on an unassigned row', !unCard?.textContent.includes('Not our department'));
      t.ok('department staff never sees an assign picker', !v.text().includes('Choose a department'));
      t.ok('the reason is pre-filled and editable',
        (myCard?.querySelector('.routing-action-row input')?.value ?? '').toLowerCase().includes('triage'),
        myCard?.querySelector('.routing-action-row input')?.value);
      t.ok('the routing row is styled distinctly from the status row',
        !!myCard?.querySelector('.routing-action-row') && !!myCard?.querySelector('.status-action-row'));

      await v.click(myCard.querySelector('.routing-action'));

      const after = await rowById(mine.submission_id);
      t.ok('clicking it really bounced the row', after?.department_id === null, after?.department_id);
      const cardAfter = v.cardTitled(T('BounceMe'));
      t.ok('the bounce button disappears afterwards', !cardAfter?.textContent.includes('Not our department'),
        cardAfter?.textContent.slice(0, 120));
      t.ok('and the old department is left with no action at all',
        !cardAfter?.querySelector('.routing-action') && !cardAfter?.querySelector('.status-action'),
        cardAfter?.textContent.slice(0, 120));
      t.ok('a confirmation is shown', /Returned/i.test(v.text()), v.text().slice(0, 120));
      await v.unmount();
    }

    // --- triage ----------------------------------------------------------
    t.section('triage sees the assign picker only on unassigned rows');

    {
      const v = await renderList({ role: 'triage', department_id: null });
      const unCard = v.cardTitled(T('Unassigned'));
      const assignedCard = v.cardTitled(T('NotMine'));

      t.ok('triage does not see the bounce button', !v.text().includes('Not our department'));
      t.ok('the picker shows on an unassigned row', !!unCard?.querySelector('.routing-department-select'));
      t.ok('the picker is hidden on an assigned row', !assignedCard?.querySelector('.routing-department-select'),
        assignedCard?.textContent.slice(0, 100));
      t.ok('the picker offers the real departments',
        [...(unCard?.querySelectorAll('.routing-department-select option') ?? [])]
          .some((o) => o.textContent.includes('Hostel Maintenance')),
        [...(unCard?.querySelectorAll('.routing-department-select option') ?? [])].map((o) => o.textContent).join('|'));
      t.ok('the picker has no pre-selected department',
        unCard?.querySelector('.routing-department-select')?.value === '',
        unCard?.querySelector('.routing-department-select')?.value);

      // Assigning without choosing must not silently pick something.
      await v.click(unCard.querySelector('.routing-action'));
      t.ok('assigning with nothing chosen is refused', /Pick a department/i.test(v.text()), v.text().slice(0, 120));
      t.ok('...and nothing was written', (await rowById(unassigned.submission_id))?.department_id === null);

      const select = unCard.querySelector('.routing-department-select');
      const hostel = [...select.options].find((o) => o.textContent.includes('Hostel Maintenance'));
      await v.choose(select, hostel.value);
      t.ok('the selection registers', select.value === hostel.value, select.value);
      await v.click(unCard.querySelector('.routing-action'));

      t.ok('the chosen department was written',
        String((await rowById(unassigned.submission_id))?.department_id) === hostel.value,
        (await rowById(unassigned.submission_id))?.department_id);
      t.ok('the picker disappears after assigning',
        !v.cardTitled(T('Unassigned'))?.querySelector('.routing-department-select'));
      t.ok('the confirmation names the department', /Assigned/i.test(v.text()), v.text().slice(0, 140));
      await v.unmount();
    }

    // --- admin -----------------------------------------------------------
    t.section('admin bounces across departments but not from nothing');

    {
      await createSubmission({ department_id: '1', title: T('AdminAssigned') });
      // Fresh row: the fixture above was assigned in the previous section, so it
      // can no longer stand in for "unassigned".
      await createSubmission({ title: T('AdminUnassigned') });
      const v = await renderList({ role: 'admin', department_id: null });
      const assignedCard = v.cardTitled(T('AdminAssigned'));
      const unCard = v.cardTitled(T('AdminUnassigned'));

      t.ok('admin sees the bounce button on an assigned row', !!assignedCard?.textContent.includes('Not our department'),
        assignedCard?.textContent.slice(0, 100));
      t.ok('admin does NOT see it on an unassigned row, which the server would refuse',
        !unCard?.textContent.includes('Not our department'), unCard?.textContent.slice(0, 120));
      t.ok('admin sees the picker on the unassigned row', !!unCard?.querySelector('.routing-department-select'));
      await v.unmount();
    }

    // --- everyone else ---------------------------------------------------
    t.section('other roles see neither action');

    {
      const v = await renderList({ role: 'council', department_id: null });
      t.ok('council sees no bounce button', !v.text().includes('Not our department'));
      t.ok('council sees no assign picker', !v.text().includes('Choose a department'));
      t.ok('council sees no routing controls at all', !v.q('.routing-action-row'));
      await v.unmount();
    }
    {
      const v = await renderList(null);
      t.ok('a signed-out visitor sees no routing controls', !v.q('.routing-action-row'));
      await v.unmount();
    }

    // --- tracking page ---------------------------------------------------
    t.section('the tracking page distinguishes reassignments');

    {
      const s = await createSubmission({ department_id: '1', title: T('Tracked') });
      await nativeFetch(`${base}/submissions/${s.submission_id}/bounce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: jars.dept },
        body: JSON.stringify({ reason: 'Wrong department for this one' }),
      });
      await nativeFetch(`${base}/submissions/${s.submission_id}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: jars.triage },
        body: JSON.stringify({ department_id: 2, reason: 'Mess Committee should take this' }),
      });
      await nativeFetch(`${base}/submissions/${s.submission_id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: jars.admin },
        body: JSON.stringify({ new_status: 'acknowledged', reason: 'Acknowledged by the committee' }),
      });

      // Fetched through the real api.js, so the rendered shape is the shape the
      // server actually returns.
      const submission = await lookupSubmissionByToken(s.submission_token);
      currentJar = '';
      const host = dom.window.document.getElementById('root');
      host.innerHTML = '';
      const root = ReactDOMClient.createRoot(host);
      await act(async () => { root.render(React.createElement(TrackResult, { submission })); });
      await act(async () => { await sleep(200); });

      const entries = [...host.querySelectorAll('.timeline-entry')];
      t.ok('every event is rendered', entries.length === 4, entries.length);
      t.ok('two entries are marked as reassignments',
        entries.filter((e) => e.classList.contains('reassignment')).length === 2,
        entries.filter((e) => e.classList.contains('reassignment')).length);
      t.ok('two are marked as status changes',
        entries.filter((e) => e.classList.contains('status')).length === 2);
      t.ok('reassignments are labelled', entries.filter((e) => e.textContent.includes('Reassigned')).length === 2);
      t.ok('a bounce reads as a department becoming Unassigned',
        entries.some((e) => e.textContent.includes('Hostel Maintenance') && e.textContent.includes('Unassigned')),
        entries.map((e) => e.textContent).join(' || ').slice(0, 240));
      t.ok('a reassign reads as Unassigned becoming a named department',
        entries.some((e) => e.textContent.includes('Unassigned') && e.textContent.includes('Mess Committee')));
      t.ok('no raw department ids reach the page',
        !/\bdepartment_id\b/.test(host.textContent) && !/department-?\d/i.test(host.textContent));
      t.ok('reassignment reasons are shown',
        host.textContent.includes('Wrong department for this one') &&
        host.textContent.includes('Mess Committee should take this'));
      t.ok('status reasons still show',
        host.textContent.includes('Acknowledged by the committee'));
      t.ok('status entries still render a badge',
        entries.filter((e) => !e.classList.contains('reassignment')).every((e) => e.querySelector('.status-badge')));
      t.ok('every entry has visible text', entries.every((e) => e.textContent.trim().length > 0));

      await act(async () => { root.unmount(); });
    }
  } finally {
    // Always put the globals back, even if a section throws, so a later suite in
    // the same process is not running inside a half-installed jsdom.
    global.window = previous.window;
    global.document = previous.document;
    global.HTMLElement = previous.HTMLElement;
    global.Event = previous.Event;
    global.FormData = previous.FormData;
    Object.defineProperty(global, 'navigator', { value: previous.navigator, configurable: true });
    global.fetch = nativeFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    await vite.close();
    dom.window.close();
  }
}
