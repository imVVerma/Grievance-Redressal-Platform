import { useState } from "react";
import { createSubmission, previewRedaction } from "./api";

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
//
// RedactionPreview is the pre-submission safety net. It shows the exact text
// that will be stored so the change is never a surprise, and it offers a way
// back into the form rather than forcing the masked version on anyone.
export function RedactionPreview({ preview, onConfirm, onEdit, busy }) {
  return (
    <div className="redaction-preview" role="status">
      <h3 className="redaction-preview-title">We found a name in your text</h3>
      <p className="redaction-preview-note">
        To protect the people you mention, names are replaced with{" "}
        <code>[REDACTED]</code> before anything is stored. This is what will be
        saved:
      </p>

      <dl className="redaction-preview-text">
        <dt>Title</dt>
        <dd>{preview.redactedTitle}</dd>
        <dt>Description</dt>
        <dd>{preview.redactedDescription}</dd>
      </dl>

      <div className="redaction-preview-actions">
        <button type="button" className="redaction-confirm" onClick={onConfirm} disabled={busy}>
          {busy ? "Submitting…" : "Submit this version"}
        </button>
        <button type="button" className="redaction-edit" onClick={onEdit} disabled={busy}>
          Edit and check again
        </button>
      </div>
    </div>
  );
}

// Exported on its own so it can be rendered and inspected in a test without
// driving the whole form.
export function TokenReceipt({ token, wasAnonymous, copied, copyFailed, redacted, onCopy, onDismiss }) {
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

      {redacted && (
        <p className="token-receipt-redacted">
          Note: a name was detected in your text as you submitted it, so we
          stored the redacted version instead. The text you see above is what
          was saved.
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
  // Set only when the server says it would mask something. While it is held,
  // nothing has been submitted — the user still has the final say.
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);

  const busy = submitting || checking;

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

  async function sendToServer(title, description) {
    try {
      const created = await createSubmission({
        ...form,
        title,
        description,
        category_id: form.category_id || null,
        department_id: form.department_id || null,
      });
      setReceipt({
        token: created.submission_token,
        wasAnonymous: form.is_anonymous,
        // The server redacts again on the way in, so this can be true even when
        // the preview found nothing — the last edit may have slipped a name past
        // the check. Either way the user is told the stored text was altered.
        redacted: created.redacted === true,
      });
      setCopied(false);
      setCopyFailed(false);
      setForm(initialForm);
      setPreview(null);
      onSubmitted?.();
    } catch {
      setError("Could not submit right now. Try again.");
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!form.title.trim() || !form.description.trim()) {
      setError("Title and description are required.");
      return;
    }

    setChecking(true);
    try {
      const result = await previewRedaction({
        title: form.title,
        description: form.description,
      });

      if (result.flaggedCount > 0) {
        // Hold here. Nothing is sent until the user confirms the masked text.
        setPreview(result);
        return;
      }

      // Nothing flagged, so there is nothing to confirm — submit as typed.
      setChecking(false);
      setSubmitting(true);
      await sendToServer(form.title, form.description);
    } catch {
      setError("Could not check your text for names right now. Try again.");
    } finally {
      setChecking(false);
      setSubmitting(false);
    }
  }

  function confirmRedacted() {
    if (!preview) return;
    setSubmitting(true);
    sendToServer(preview.redactedTitle, preview.redactedDescription).finally(() =>
      setSubmitting(false)
    );
  }

  // Hand the masked text back to the form so the user can reword around it
  // rather than being stuck with [REDACTED] forever.
  function editAndRecheck() {
    if (!preview) return;
    setForm((prev) => ({
      ...prev,
      title: preview.redactedTitle,
      description: preview.redactedDescription,
    }));
    setPreview(null);
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

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={form.is_anonymous}
          onChange={(e) => update("is_anonymous", e.target.checked)}
        />
        <span>Submit Anonymously</span>
      </label>

      {error && <p className="form-error">{error}</p>}

      {preview && (
        <RedactionPreview
          preview={preview}
          busy={busy}
          onConfirm={confirmRedacted}
          onEdit={editAndRecheck}
        />
      )}

      <button type="submit" disabled={busy}>
        {checking ? "Checking…" : submitting ? "Submitting…" : "Submit"}
      </button>

      {receipt && (
        <TokenReceipt
          token={receipt.token}
          wasAnonymous={receipt.wasAnonymous}
          redacted={receipt.redacted}
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
