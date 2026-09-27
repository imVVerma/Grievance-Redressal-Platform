import { useCallback, useEffect, useState } from "react";
import {
  bounceSubmission,
  fetchDepartments,
  fetchSubmissions,
  reassignSubmission,
  updateSubmissionStatus,
} from "./api";
import StatusBadge from "./StatusBadge";
import { labelForStatus, nextStatusFor } from "./statuses";
import { canAdvanceStatus, canBounce, canReassign, everReassigns } from "./staffAccess";
import { formatTimestamp } from "./datetime";

// Pre-filled into the reason box so a one-click advance still records a usable
// reason, while letting whoever is triaging add the real detail.
const SUGGESTED_REASONS = {
  acknowledged: "Acknowledgement recorded.",
  in_progress: "Work started on this submission.",
  pending_council_review: "Escalated to the student council for review.",
  resolved: "Resolution proposed by the department.",
  closed: "Closure approved after council review.",
};

const MAX_REASON_LENGTH = 255;

// Pre-filled into the reason box so a bounce or an assignment records something
// usable even if nobody types, while still letting whoever is acting add the real
// detail. Both say what happened rather than why, so the writer is nudged to
// replace them rather than accept them.
const BOUNCE_REASON = "Returned to triage — not our department.";
const REASSIGN_REASON = "Assigned for handling.";

export default function SubmissionList({ refreshKey, session }) {
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  // submission_id -> reason being typed. Absent means "use the suggestion".
  const [draftReasons, setDraftReasons] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [feedback, setFeedback] = useState(null);
  // The staff session comes in as a prop from the app shell rather than being
  // fetched here. The header indicator shows the same value, and the two cannot
  // drift apart: signing in or out rewrites the one copy, so the action rows
  // below appear or disappear in the same paint as the header. A private fetch
  // in this component would be a second source of truth, and could disagree
  // with the indicator for as long as it took to notice.
  //
  // null means "not known yet" and canAdvanceStatus treats it as signed out, so
  // no controls flash before the session lookup settles.
  const staff = session;

  // The departments offered in the assignment picker, for the rows triage is
  // meant to pick up. Fetched only when the viewer could actually use it, so a
  // department_staff member browsing a fully-routed queue never issues a
  // request whose result they have no way to act on. Same public endpoint the
  // submission form uses; it is reference data, not a second source of truth
  // for anything.
  const [departments, setDepartments] = useState([]);
  // submission_id -> department_id chosen in the assignment picker, and its own
  // reason box keyed separately from the status reason so the two never
  // overwrite each other.
  const [pickedDepartments, setPickedDepartments] = useState({});
  const [bounceReasons, setBounceReasons] = useState({});
  const [reassignReasons, setReassignReasons] = useState({});
  // Tracks which action is mid-flight per row, so one button disables without
  // disabling the row's others: bouncing and advancing are not the same
  // decision and a slow one should not block the other.
  const [busyAction, setBusyAction] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    return fetchSubmissions()
      .then(setSubmissions)
      .catch(() => setSubmissions([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!everReassigns(staff)) return;
    let cancelled = false;
    fetchDepartments()
      .then((rows) => {
        if (!cancelled) setDepartments(rows);
      })
      .catch(() => {
        // Non-blocking: the picker simply offers no options, and the reason
        // text still explains why nothing is actionable there.
      });
    return () => {
      cancelled = true;
    };
  }, [staff]);

  // Clear the banner on its own so a stale result can't be misread later.
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  async function handleAdvance(submission) {
    const next = nextStatusFor(submission.status);
    if (!next) return;

    const reason = (draftReasons[submission.submission_id] ?? SUGGESTED_REASONS[next] ?? "").trim();
    if (!reason) {
      setFeedback({ kind: "error", text: "Add a short reason before advancing the status." });
      return;
    }

    setBusyId(submission.submission_id);
    try {
      const updated = await updateSubmissionStatus(submission.submission_id, next, reason);
      setSubmissions((prev) =>
        prev.map((item) => (item.submission_id === updated.submission_id ? updated : item))
      );
      setDraftReasons((prev) => {
        const remaining = { ...prev };
        delete remaining[submission.submission_id];
        return remaining;
      });
      setFeedback({
        kind: "success",
        text: `Moved "${updated.title}" to ${labelForStatus(updated.status)}.`,
      });
    } catch (err) {
      setFeedback({ kind: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  // Return a submission to triage. The row comes back with department_id null,
  // which is the whole point: the server's response is the authoritative
  // post-write state, so the row is replaced with it rather than patched
  // locally. That also means the "Not our department" button disappears on its
  // own and the status action reappears if the viewer is a triage/admin who
  // could pick it up — no second source of truth about who owns what.
  async function handleBounce(submission) {
    const reason = (bounceReasons[submission.submission_id] ?? BOUNCE_REASON).trim();
    if (!reason) {
      setFeedback({ kind: "error", text: "Add a short reason before returning it to triage." });
      return;
    }

    setBusyAction((prev) => ({ ...prev, [submission.submission_id]: "bounce" }));
    try {
      const updated = await bounceSubmission(submission.submission_id, reason);
      setSubmissions((prev) =>
        prev.map((item) => (item.submission_id === updated.submission_id ? updated : item))
      );
      setBounceReasons((prev) => {
        const remaining = { ...prev };
        delete remaining[submission.submission_id];
        return remaining;
      });
      setFeedback({
        kind: "success",
        text: `Returned "${updated.title}" to triage. It now has no department.`,
      });
    } catch (err) {
      setFeedback({ kind: "error", text: err.message });
    } finally {
      setBusyAction((prev) => {
        const remaining = { ...prev };
        delete remaining[submission.submission_id];
        return remaining;
      });
    }
  }

  // Route an unassigned submission to the department picked in the row's
  // dropdown. Deliberately does not let the picker default to anything: an
  // unassigned submission with a department silently chosen by a default
  // dropdown option is exactly the wrong record to end up with, so the choice
  // has to be made on purpose.
  async function handleReassign(submission) {
    const picked = pickedDepartments[submission.submission_id] ?? "";
    const reason = (reassignReasons[submission.submission_id] ?? REASSIGN_REASON).trim();

    if (!picked) {
      setFeedback({ kind: "error", text: "Pick a department before assigning this." });
      return;
    }
    if (!reason) {
      setFeedback({ kind: "error", text: "Add a short reason before assigning this." });
      return;
    }

    setBusyAction((prev) => ({ ...prev, [submission.submission_id]: "reassign" }));
    try {
      const updated = await reassignSubmission(submission.submission_id, picked, reason);
      setSubmissions((prev) =>
        prev.map((item) => (item.submission_id === updated.submission_id ? updated : item))
      );
      setPickedDepartments((prev) => {
        const remaining = { ...prev };
        delete remaining[submission.submission_id];
        return remaining;
      });
      const name = departments.find((d) => String(d.department_id) === String(picked))?.name;
      setFeedback({
        kind: "success",
        text: `Assigned "${updated.title}" to ${name ?? "a department"}.`,
      });
    } catch (err) {
      setFeedback({ kind: "error", text: err.message });
    } finally {
      setBusyAction((prev) => {
        const remaining = { ...prev };
        delete remaining[submission.submission_id];
        return remaining;
      });
    }
  }

  const visible = submissions
    .filter((s) => typeFilter === "all" || s.submission_type === typeFilter)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return (
    <div className="submission-list">
      <div className="list-controls">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All submissions</option>
          <option value="request">Service requests</option>
          <option value="complaint">Complaints</option>
        </select>
      </div>

      {feedback && (
        <p className={`list-feedback ${feedback.kind}`} role="status">
          {feedback.text}
        </p>
      )}

      {loading && <p className="loading-state">Loading…</p>}

      {!loading && visible.length === 0 && (
        <p className="empty-state">Nothing here yet — submit something to see it appear.</p>
      )}

      <ul className="list">
        {visible.map((s) => {
          const next = nextStatusFor(s.status);
          const busy = busyId === s.submission_id;
          return (
            <li key={s.submission_id} className="list-item">
              <div className="list-item-header">
                <span className="list-item-title">{s.title}</span>
                <StatusBadge status={s.status} />
              </div>
              <p className="list-item-description">{s.description}</p>
              {s.location && (
                <p className="list-item-location">
                  <strong>Location:</strong> {s.location}
                </p>
              )}
              <div className="list-item-meta">
                <span>{s.submission_type === "request" ? "Request" : "Complaint"}</span>
                <span>{s.is_anonymous ? "🕵️ Anonymous" : "👤 Known User"}</span>
                <span>{formatTimestamp(s.created_at)}</span>
              </div>

              {/* Only the immediate next status is ever offered, and a closed
                  submission gets no action at all. canAdvanceStatus applies the
                  same rule as the server gate — a signed-out visitor, a staff
                  member looking at another department's item, and anyone but
                  council/admin facing a resolved -> closed transition all get
                  no button here, rather than a button whose click would be
                  refused. */}
              {canAdvanceStatus(staff, s, next) && (
                <div className="status-action-row">
                  <input
                    type="text"
                    className="status-reason-input"
                    value={draftReasons[s.submission_id] ?? SUGGESTED_REASONS[next] ?? ""}
                    maxLength={MAX_REASON_LENGTH}
                    disabled={busy}
                    onChange={(e) =>
                      setDraftReasons((prev) => ({ ...prev, [s.submission_id]: e.target.value }))
                    }
                    placeholder="Reason for this status change"
                  />
                  <button
                    type="button"
                    className="status-action"
                    onClick={() => handleAdvance(s)}
                    disabled={busy}
                  >
                    {busy ? "Updating…" : `Mark as ${labelForStatus(next)}`}
                  </button>
                </div>
              )}

              {/* Bounce-back, half one. Only offered to the department that
                  currently holds the row, which is the same scoping rule the
                  status action uses, and only while it is held at all — an
                  unassigned row is triage's to route, not a department's to
                  decline. */}
              {canBounce(staff, s) && (
                <div className="routing-action-row">
                  <input
                    type="text"
                    className="status-reason-input"
                    value={bounceReasons[s.submission_id] ?? BOUNCE_REASON}
                    maxLength={MAX_REASON_LENGTH}
                    disabled={busyAction[s.submission_id] === "bounce"}
                    onChange={(e) =>
                      setBounceReasons((prev) => ({ ...prev, [s.submission_id]: e.target.value }))
                    }
                    placeholder="Why is this not yours?"
                  />
                  <button
                    type="button"
                    className="routing-action"
                    onClick={() => handleBounce(s)}
                    disabled={busyAction[s.submission_id] === "bounce"}
                  >
                    {busyAction[s.submission_id] === "bounce" ? "Returning…" : "Not our department"}
                  </button>
                </div>
              )}

              {/* Bounce-back, half two. Triage's entire queue is "rows with no
                  department" out of the listing this component already has, so
                  there is no separate dashboard to keep in sync. The dropdown
                  deliberately has no pre-selected option: see handleReassign. */}
              {canReassign(staff, s) && (
                <div className="routing-action-row reassign">
                  <select
                    className="routing-department-select"
                    aria-label="Department to assign"
                    value={pickedDepartments[s.submission_id] ?? ""}
                    disabled={busyAction[s.submission_id] === "reassign"}
                    onChange={(e) =>
                      setPickedDepartments((prev) => ({
                        ...prev,
                        [s.submission_id]: e.target.value,
                      }))
                    }
                  >
                    <option value="">Choose a department…</option>
                    {departments.map((d) => (
                      <option key={d.department_id} value={d.department_id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    className="status-reason-input"
                    value={reassignReasons[s.submission_id] ?? REASSIGN_REASON}
                    maxLength={MAX_REASON_LENGTH}
                    disabled={busyAction[s.submission_id] === "reassign"}
                    onChange={(e) =>
                      setReassignReasons((prev) => ({ ...prev, [s.submission_id]: e.target.value }))
                    }
                    placeholder="Why this department?"
                  />
                  <button
                    type="button"
                    className="routing-action"
                    onClick={() => handleReassign(s)}
                    disabled={busyAction[s.submission_id] === "reassign"}
                  >
                    {busyAction[s.submission_id] === "reassign" ? "Assigning…" : "Assign department"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
