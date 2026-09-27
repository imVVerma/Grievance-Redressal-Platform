import { useState } from "react";
import { lookupSubmissionByToken } from "./api";
import StatusBadge from "./StatusBadge";
import { labelForStatus } from "./statuses";
import { formatTimestamp } from "./datetime";

// The submitted code, pasted back in. Kept in a plain uncontrolled-ish input
// because the value is a 32-character opaque string the user copies from
// elsewhere — there is nothing to validate beyond "did the server find it".
export function TrackResult({ submission }) {
  const history = submission.history ?? [];

  return (
    <div className="track-result">
      <div className="list-item-header">
        <span className="list-item-title">{submission.title}</span>
        <StatusBadge status={submission.status} />
      </div>

      <p className="list-item-description">{submission.description}</p>

      {submission.location && (
        <p className="list-item-location">
          <strong>Location:</strong> {submission.location}
        </p>
      )}

      <div className="list-item-meta">
        <span>{submission.submission_type === "request" ? "Request" : "Complaint"}</span>
        <span>Submitted {formatTimestamp(submission.created_at)}</span>
      </div>

      <h3 className="track-timeline-heading">Progress</h3>
      {history.length === 0 ? (
        <p className="empty-state">No status history recorded yet.</p>
      ) : (
        // Oldest first — the server already orders the merged status +
        // reassignment timeline, and the copy here just makes that guarantee
        // visible at the point of use.
        //
        // An entry with no `type` is treated as a status change. That is not
        // defensive padding: the field is new, and a token lookup answered by an
        // older build (or a cached response) would send entries without it.
        // Defaulting keeps those rendering as they always did instead of
        // showing an empty row.
        <ol className="timeline">
          {history.map((entry, index) => {
            const isReassignment = entry.type === "reassignment";
            return (
              <li
                key={`${entry.changed_at}-${entry.type ?? "status"}-${index}`}
                className={`timeline-entry ${isReassignment ? "reassignment" : "status"}`}
              >
                <div className="timeline-entry-head">
                  {isReassignment ? (
                    <>
                      <span className="timeline-reassign-label">Reassigned</span>
                      <span className="timeline-departments">
                        {entry.old_department} <span aria-hidden="true">→</span>{" "}
                        {entry.new_department}
                      </span>
                    </>
                  ) : (
                    <>
                      <StatusBadge status={entry.new_status} />
                      {entry.old_status && (
                        <span className="timeline-from">
                          from {labelForStatus(entry.old_status)}
                        </span>
                      )}
                    </>
                  )}
                </div>
                {entry.reason && <p className="timeline-reason">{entry.reason}</p>}
                <span className="timeline-time">
                  {formatTimestamp(entry.changed_at)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export default function TrackSubmission() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [submission, setSubmission] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);

  async function handleLookup(e) {
    e.preventDefault();
    const trimmed = code.trim();

    if (!trimmed) {
      setError("Paste the code you were given when you submitted.");
      setNotFound(false);
      setSubmission(null);
      return;
    }

    setLoading(true);
    setError(null);
    setNotFound(false);
    setSubmission(null);

    try {
      setSubmission(await lookupSubmissionByToken(trimmed));
    } catch (err) {
      // A miss and a malformed code are the same 404 with the same text on
      // purpose, so this branch never says which of the two it was.
      if (err.status === 404) {
        setNotFound(true);
      } else {
        setError("Could not check that code right now. Try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="track">
      <form onSubmit={handleLookup} className="submission-form track-form">
        <h2 className="track-heading">Check a submission</h2>
        <p className="track-blurb">
          Paste the code you saved when you submitted. No account needed.
        </p>

        <label className="field">
          Your code
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. 3f9a…"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        {error && <p className="form-error">{error}</p>}
        {notFound && <p className="track-not-found">No submission found for that code.</p>}

        <button type="submit" disabled={loading}>
          {loading ? "Checking…" : "Check status"}
        </button>
      </form>

      {submission && <TrackResult submission={submission} />}
    </div>
  );
}
