import { useCallback, useEffect, useState } from "react";
import SubmissionForm from "./SubmissionForm";
import SubmissionList from "./SubmissionList";
import TrackSubmission from "./TrackSubmission";
import StaffLogin from "./StaffLogin";
import { fetchStaffSession, staffLogout } from "./api";
import { roleLabel } from "./staffAccess";
import "./App.css";

// /staff/login is the one path that is not a view switch inside the SPA.
//
// Read straight off window.location rather than pulling in a routing library:
// the app has exactly two shapes (the student app, and the staff sign-in page)
// and a dependency plus a route table would be a lot of machinery for that. The
// cost is that this is a full page load rather than a client-side transition,
// which is fine for a page nobody is meant to navigate to from the UI — it is
// typed or bookmarked, and deliberately absent from the navigation.
const STAFF_LOGIN_PATH = "/staff/login";

function isStaffLoginPath(pathname) {
  return pathname === STAFF_LOGIN_PATH;
}

// What the session looks like to the rest of the app when nobody is signed in.
// A concrete object rather than null so components can read `.role` without
// guarding every access, and so "signed out" is one value instead of two
// (null vs undefined) that quietly disagree.
const SIGNED_OUT = { role: null, department_id: null };

// The header's staff-session indicator: present on all three main views, so the
// current role is visible wherever staff happen to be working, and signing out
// is reachable without navigating back to the sign-in page.
function StaffSessionIndicator({ session, busy, onLogout }) {
  if (!session?.role) return null;

  return (
    <div className="staff-indicator">
      <span className="staff-indicator-label">
        Staff: <strong>{roleLabel(session.role)}</strong>
        {session.department_id != null && (
          <span className="staff-indicator-dept"> · dept {session.department_id}</span>
        )}
      </span>
      <button
        type="button"
        className="staff-indicator-logout"
        onClick={onLogout}
        disabled={busy}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("submit"); // "submit" | "browse" | "track"
  const [refreshKey, setRefreshKey] = useState(0);
  // The one and only copy of session state in the frontend. The header
  // indicator and SubmissionList's action rows both read this one value, so
  // they cannot disagree about whether anyone is signed in. It is refreshed
  // from GET /staff/me -- the same call that already existed -- and written
  // directly after a successful sign-in or sign-out so the UI updates without
  // waiting on a round trip.
  //
  // null means "not known yet". canAdvanceStatus treats it as signed out, so
  // no action buttons flash before the session lookup settles.
  const [session, setSession] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  const refreshSession = useCallback(() => {
    return fetchStaffSession()
      .then(setSession)
      // Failing to ask is treated as "signed out", which is the safe direction:
      // it shows fewer actions, and the server would refuse them anyway.
      .catch(() => setSession(SIGNED_OUT));
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // Re-check whenever the tab regains focus, so signing in or out in another
  // tab is picked up. This preserves what the per-view fetch used to do without
  // giving each view its own copy of the session.
  useEffect(() => {
    const onFocus = () => refreshSession();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshSession]);

  function handleSubmitted() {
    // Refresh the list so it is current when the user goes to Browse, but stay
    // on the form: the submitter still has to read and copy their tracking
    // code, and navigating away would hide it before they can.
    setRefreshKey((k) => k + 1);
  }

  // Called by the sign-in page once POST /staff/login has succeeded.
  //
  // Landing on Browse is the point of the flow: the action buttons appearing on
  // real rows is the visible proof that the session is live, which is more
  // convincing than any confirmation message. Submitting the form first would
  // have them waiting on an empty list.
  function handleSignedIn(nextSession) {
    setSession(nextSession);
    setView("browse");
    // Drop /staff/login from the address bar without a reload, so a refresh
    // lands on the app rather than bouncing back to the sign-in page, and so
    // the Back button does not return to a form that is already spent. The
    // pathname is read during render, so this also flips which branch below is
    // taken on the re-render that setSession already scheduled.
    window.history.replaceState({}, "", "/");
  }

  async function handleLogout() {
    setSigningOut(true);
    try {
      await staffLogout();
    } catch {
      // Fall through: even if the request failed, clearing local state is the
      // right move, and the next focus re-check will correct it against the
      // server's actual answer.
    } finally {
      setSession(SIGNED_OUT);
      setSigningOut(false);
    }
  }

  // Renders instead of the app, not alongside it: the staff sign-in page is a
  // standalone surface, so the student header and navigation do not appear on
  // it and there is no way back into them from here. The session is still owned
  // above, so signing in here hands straight over to the main app.
  if (isStaffLoginPath(window.location.pathname)) {
    return (
      <div className="app">
        <StaffLogin
          session={session}
          onSignedIn={handleSignedIn}
          onSignOut={handleLogout}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <span className="app-header-eyebrow">Student Affairs</span>
          <h1>Grievance Redressal</h1>
          <p className="app-header-subtitle">
            Submit, track and resolve campus complaints and service requests.
          </p>
        </div>
        <div className="app-header-controls">
          <nav>
            <button
              className={view === "submit" ? "active" : ""}
              onClick={() => setView("submit")}
            >
              Submit
            </button>
            <button
              className={view === "browse" ? "active" : ""}
              onClick={() => setView("browse")}
            >
              Browse
            </button>
            <button
              className={view === "track" ? "active" : ""}
              onClick={() => setView("track")}
            >
              Track
            </button>
          </nav>
          <StaffSessionIndicator
            session={session}
            busy={signingOut}
            onLogout={handleLogout}
          />
        </div>
      </header>

      <main className="app-main">
        {view === "submit" && <SubmissionForm onSubmitted={handleSubmitted} />}
        {view === "browse" && (
          <SubmissionList refreshKey={refreshKey} session={session} />
        )}
        {view === "track" && <TrackSubmission />}
      </main>
    </div>
  );
}
