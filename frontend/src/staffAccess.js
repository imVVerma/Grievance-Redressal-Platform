// The client-side half of the access rules in backend/auth.js.
//
// Purpose: decide whether to *show* an action button, and to describe the
// current session in words. The server is the only thing that actually enforces
// anything — this file changes what a user is offered, never what they are
// allowed to do, and a bug here produces a missing button rather than a security
// hole.
//
// That direction is deliberate. Hiding a button the server would have allowed
// is a small, recoverable annoyance; showing a button the server will reject
// teaches staff that the interface is unreliable. The original code showed the
// button to everyone and let the click 401, which is the version worth fixing.
//
// Kept in its own module because several call sites need it (SubmissionList for
// the button, the header indicator for the role name, and the tests), and
// because a rule duplicated inline in a component is a rule that quietly drifts
// out of sync with the server.

export const ROLES = {
  DEPARTMENT_STAFF: "department_staff",
  TRIAGE: "triage",
  COUNCIL: "council",
  ADMIN: "admin",
};

// Human-readable names for the header indicator and the sign-in page. The
// underscore-separated enum value is the database value and must not leak into
// the UI, where "department_staff" reads like a variable name.
const ROLE_LABELS = {
  [ROLES.DEPARTMENT_STAFF]: "Department staff",
  [ROLES.TRIAGE]: "Triage",
  [ROLES.COUNCIL]: "Council",
  [ROLES.ADMIN]: "Administrator",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? (role ? String(role) : "");
}

// Who may perform which class of transition. Mirrors CLOSING_ROLES and
// ADVANCING_ROLES in backend/auth.js.
const CLOSING_ROLES = [ROLES.COUNCIL, ROLES.ADMIN];
const ADVANCING_ROLES = [ROLES.DEPARTMENT_STAFF, ROLES.ADMIN];

// `staff` is the /staff/me payload: { role, department_id } or { role: null }.
export function isSignedIn(staff) {
  return Boolean(staff && staff.role);
}

// Whether this staff member may advance `submission` to `nextStatus`.
//
//   * to "closed"          -> council or admin, any department
//   * any other transition -> department_staff or admin
//   * department_staff     -> the submission's own department only
//
// Returns false rather than throwing: a row with no allowed action is a normal
// state, and the caller simply does not render the row of controls.
export function canAdvanceStatus(staff, submission, nextStatus) {
  if (!isSignedIn(staff)) return false;
  // A submission already at its final status has no transition to offer at all,
  // whoever is asking.
  if (!nextStatus) return false;

  if (nextStatus === "closed") {
    return CLOSING_ROLES.includes(staff.role);
  }

  if (!ADVANCING_ROLES.includes(staff.role)) return false;
  // Admins act across every department.
  if (staff.role === ROLES.ADMIN) return true;

  // Two unknowns are not a match: an unassigned staff member and an unassigned
  // submission must not pair up by both happening to be null. This mirrors the
  // server, and it is the conservative direction.
  if (staff.department_id == null || submission?.department_id == null) return false;

  return Number(staff.department_id) === Number(submission.department_id);
}
