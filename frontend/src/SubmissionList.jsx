import { useEffect, useState } from "react";
import { fetchSubmissions } from "./api";
import StatusBadge from "./StatusBadge";

export default function SubmissionList({ refreshKey }) {
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    setLoading(true);
    fetchSubmissions()
      .then(setSubmissions)
      .catch(() => setSubmissions([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

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

      {loading && <p>Loading…</p>}

      {!loading && visible.length === 0 && (
        <p className="empty-state">Nothing here yet — submit something to see it appear.</p>
      )}

      <ul className="list">
        {visible.map((s) => (
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
          </li>
        ))}
      </ul>
    </div>
  );
}
