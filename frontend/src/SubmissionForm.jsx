import { useState } from "react";
import { createSubmission } from "./api";

// Placeholder lists — once you build the /departments and /categories
// endpoints (matching the schema's tables), fetch these instead of
// hardcoding them.
const DEPARTMENTS = [
  { department_id: 1, name: "Hostel Maintenance" },
  { department_id: 2, name: "Mess Committee" },
  { department_id: 3, name: "Academic Office" },
];

const CATEGORIES = [
  { category_id: 1, name: "Plumbing", submission_type: "request" },
  { category_id: 2, name: "Electrical", submission_type: "request" },
  { category_id: 3, name: "Mess Food Quality", submission_type: "complaint" },
  { category_id: 4, name: "Administrative Coordination", submission_type: "complaint" },
];

const initialForm = {
  submission_type: "request",
  title: "",
  description: "",
  category_id: "",
  department_id: "",
  location: "",
  is_anonymous: false,
};

// Exported on its own so it can be rendered and inspected in a test without
// driving the whole form.
export function TokenReceipt({ token, wasAnonymous, copied, copyFailed, onCopy, onDismiss }) {
  return (
    <div className="token-receipt" role="status">
      <h3 className="token-receipt-title">Save this code to check your status later</h3>
      <p className="token-receipt-note">
        {wasAnonymous
          ? "You submitted anonymously, so this code is the only way to find this submission again. Copy it somewhere safe — we cannot show it to you a second time."
          : "Copy this code somewhere safe — we cannot show it to you a second time, and it is the only way to check this submission's progress."}
      </p>

      <div className="token-row">
        <input
          type="text"
          className="token-value"
          value={token}
          readOnly
          aria-label="Your submission code"
          onFocus={(e) => e.target.select()}
        />
        <button type="button" className="token-copy" onClick={onCopy}>
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>

      {copyFailed && (
        <p className="token-copy-failed">
          Could not copy automatically — select the code above and copy it manually.
        </p>
      )}

      <button type="button" className="token-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export default function SubmissionForm({ onSubmitted }) {
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // The receipt stays on screen until dismissed or replaced by a new submission.
  // It is the only handle the submitter ever gets, so it is never auto-hidden.
  const [receipt, setReceipt] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const filteredCategories = CATEGORIES.filter(
    (c) => c.submission_type === form.submission_type
  );

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleCopy() {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt.token);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Clipboard access needs a secure context and permission; the code is
      // still selectable in the box, so degrade instead of blocking.
      setCopied(false);
      setCopyFailed(true);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!form.title.trim() || !form.description.trim()) {
      setError("Title and description are required.");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createSubmission({
        ...form,
        category_id: form.category_id || null,
        department_id: form.department_id || null,
      });
      setReceipt({ token: created.submission_token, wasAnonymous: form.is_anonymous });
      setCopied(false);
      setCopyFailed(false);
      setForm(initialForm);
      onSubmitted?.();
    } catch (err) {
      setError("Could not submit right now. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="submission-form">
      <div className="field-row">
        <label>
          <input
            type="radio"
            name="submission_type"
            value="request"
            checked={form.submission_type === "request"}
            onChange={() => update("submission_type", "request")}
          />
          Service request
        </label>
        <label>
          <input
            type="radio"
            name="submission_type"
            value="complaint"
            checked={form.submission_type === "complaint"}
            onChange={() => update("submission_type", "complaint")}
          />
          General complaint
        </label>
      </div>

      <label className="field">
        Title
        <input
          type="text"
          value={form.title}
          onChange={(e) => update("title", e.target.value)}
          placeholder="e.g. Leaking tap in Room 214"
        />
      </label>

      <label className="field">
        Description
        <textarea
          rows={4}
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder="Describe the issue in detail"
        />
      </label>

      <label className="field">
        Location (Building/Room)
        <input
          type="text"
          value={form.location}
          onChange={(e) => update("location", e.target.value)}
          placeholder="e.g. Hostel A, Room 214"
        />
      </label>

      <label className="field">
        Category
        <select
          value={form.category_id}
          onChange={(e) => update("category_id", e.target.value)}
        >
          <option value="">Not sure / general</option>
          {filteredCategories.map((c) => (
            <option key={c.category_id} value={c.category_id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Department (optional — leave blank if unsure)
        <select
          value={form.department_id}
          onChange={(e) => update("department_id", e.target.value)}
        >
          <option value="">Route for me</option>
          {DEPARTMENTS.map((d) => (
            <option key={d.department_id} value={d.department_id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <label className="checkbox-field" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', fontWeight: 'bold' }}>
        <input
          type="checkbox"
          checked={form.is_anonymous}
          onChange={(e) => update("is_anonymous", e.target.checked)}
        />
        <span>Submit Anonymously</span>
      </label>

      {error && <p className="form-error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? "Submitting…" : "Submit"}
      </button>

      {receipt && (
        <TokenReceipt
          token={receipt.token}
          wasAnonymous={receipt.wasAnonymous}
          copied={copied}
          copyFailed={copyFailed}
          onCopy={handleCopy}
          onDismiss={() => {
            setReceipt(null);
            setCopied(false);
            setCopyFailed(false);
          }}
        />
      )}
    </form>
  );
}
