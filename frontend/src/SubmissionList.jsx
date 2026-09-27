import { useCallback, useEffect, useState } from "react";
import { fetchSubmissions, updateSubmissionStatus } from "./api";
import StatusBadge from "./StatusBadge";
import { labelForStatus, nextStatusFor } from "./statuses";

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

export default function SubmissionList({ refreshKey }) {
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  // submission_id -> reason being typed. Absent means "use the suggestion".
  const [draftReasons, setDraftReasons] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [feedback, setFeedback] = useState(null);

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

      {loading && <p>Loading…</p>}

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
              {s.location && <p className="list-item-location" style={{ fontSize: '0.9em', color: '#666', marginTop: '4px' }}><strong>Location:</strong> {s.location}</p>}
              <div className="list-item-meta">
                <span>{s.submission_type === "request" ? "Request" : "Complaint"}</span>
                <span>{s.is_anonymous ? "🕵️ Anonymous" : "👤 Known User"}</span>
                <span>{new Date(s.created_at).toLocaleString()}</span>
              </div>

              {/* Only the immediate next status is ever offered, and a closed
                  submission gets no action at all. */}
              {next && (
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
