import { useState } from "react";
import { staffLogin } from "./api";
import { roleLabel } from "./staffAccess";

// Re-exported so the route and the tests can render this without a router.
export function StaffSignedIn({ session, onLogout, onContinue, busy }) {
  return (
    <div className="staff-session" role="status">
      <p className="staff-session-line">
        Signed in as <strong>{roleLabel(session.role)}</strong>
        {session.department_id != null && (
          <>
            {" "}· department <strong>{session.department_id}</strong>
          </>
        )}
      </p>
      <p className="staff-session-note">
        Only the actions your role allows are shown in the Browse view.
      </p>
      <div className="staff-session-actions">
        <button type="button" className="token-dismiss" onClick={onLogout} disabled={busy}>
          {busy ? "Signing out…" : "Sign out"}
        </button>
        {onContinue && (
          <button type="button" className="token-dismiss" onClick={onContinue} disabled={busy}>
            Go to Browse
          </button>
        )}
      </div>
    </div>
  );
}

// The staff sign-in form, served at /staff/login.
//
// Deliberately not linked from the main navigation. Nothing a student does needs
// an account, and a sign-in link in the student-facing header would imply one is
// required — so the route exists and the app simply does not advertise it.
// Nothing below touches how this page is reached; only what happens afterwards.
//
// Session state belongs to the app shell (App.jsx), passed in as `session`.
// This page used to keep its own copy, which meant the sign-in page and the
// Browse view could hold different answers to "is anyone signed in" until one
// of them happened to refetch. Sharing the single copy means a successful
// sign-in lands on Browse already holding the right role, and signing out from
// the header is immediately reflected everywhere.
export default function StaffLogin({ session, onSignedIn, onSignOut }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // `session === null` is the app's "not known yet" value, distinct from the
  // signed-out object. Treating those two states as different is what stops the
  // form flashing for someone who already has a valid session in this browser.
  const checking = session === null;
  const signedIn = Boolean(session?.role);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const me = await staffLogin(email, password);
      setPassword("");
      // Hand the confirmed session to the shell. It stores it, switches to
      // Browse and clears /staff/login from the URL — so the effect of signing
      // in is the action buttons appearing on real rows, which is proof in a
      // way that a confirmation message is not.
      onSignedIn(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await onSignOut();
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="staff-login">
      <form onSubmit={handleSubmit} className="submission-form track-form">
        <h1 className="track-heading">Staff sign-in</h1>
        <p className="track-blurb">
          For department staff, the council and administrators. Students do not
          need an account — use the code you were given at submission to track a
          grievance.
        </p>

        {signedIn ? (
          <StaffSignedIn
            session={session}
            onLogout={handleLogout}
            onContinue={() => onSignedIn(session)}
            busy={busy}
          />
        ) : (
          <>
            <label className="field">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@uni.edu"
                autoComplete="username"
                spellCheck={false}
              />
            </label>

            <label className="field">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>

            <button type="submit" disabled={busy || !email || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        )}

        {error && <p className="form-error">{error}</p>}

        {checking && <p className="track-blurb">Checking for an existing session…</p>}
      </form>
    </div>
  );
}
