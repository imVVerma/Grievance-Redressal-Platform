const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// Authoritative status order. A submission may only move to the immediate
// next entry, so anything else is rejected. Must stay in sync with the CHECK
// constraint on submissions.status in db.js.
const STATUS_SEQUENCE = [
  'submitted',
  'acknowledged',
  'in_progress',
  'pending_council_review',
  'resolved',
  'closed',
];

// Matches the reason column width from the schema doc (VARCHAR(255)).
const MAX_REASON_LENGTH = 255;

function nextStatus(status) {
  const index = STATUS_SEQUENCE.indexOf(status);
  if (index === -1 || index === STATUS_SEQUENCE.length - 1) return null;
  return STATUS_SEQUENCE[index + 1];
}

// Errors we raise deliberately. Carrying the HTTP status lets us throw from
// inside a transaction (which rolls it back) and still respond correctly.
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new RequestError(400, message);

// Get all submissions
app.get('/submissions', (req, res) => {
  try {
    const submissions = db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
    res.json(submissions);
  } catch (error) {
    console.error('GET /submissions failed:', error);
    res.status(500).json({ error: 'Could not load submissions.' });
  }
});

// Create a new submission
app.post('/submissions', (req, res) => {
  const { submission_type, title, description, category_id, department_id, location, is_anonymous } = req.body ?? {};

  try {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    const trimmedDescription = typeof description === 'string' ? description.trim() : '';

    if (submission_type !== 'request' && submission_type !== 'complaint') {
      throw badRequest('submission_type must be either "request" or "complaint".');
    }
    if (!trimmedTitle) {
      throw badRequest('title is required.');
    }
    if (!trimmedDescription) {
      throw badRequest('description is required.');
    }

    const insert = db.prepare(`
      INSERT INTO submissions 
      (submission_type, title, description, category_id, department_id, location, is_anonymous) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Convert boolean to integer for SQLite
    const anonymousFlag = is_anonymous ? 1 : 0;

    // The submission row and its opening history row must both land, or neither.
    const create = db.transaction(() => {
      const info = insert.run(
        submission_type,
        trimmedTitle,
        trimmedDescription,
        category_id || null,
        department_id || null,
        location || null,
        anonymousFlag
      );

      // Log the initial status in history
      db.prepare(`
        INSERT INTO status_history (submission_id, new_status, reason)
        VALUES (?, 'submitted', 'Initial submission via API')
      `).run(info.lastInsertRowid);

      return info.lastInsertRowid;
    });

    res.status(201).json({ id: create(), message: "Submission successful" });
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /submissions failed:', error);
    res.status(500).json({ error: 'Could not create the submission.' });
  }
});

// Advance a submission to the next status in the workflow
app.patch('/submissions/:id/status', (req, res) => {
  const { new_status, reason } = req.body ?? {};
  const id = Number(req.params.id);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  try {
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Submission id must be a positive integer.');
    }
    if (typeof new_status !== 'string' || new_status.trim() === '') {
      throw badRequest('new_status is required.');
    }
    if (!STATUS_SEQUENCE.includes(new_status)) {
      throw badRequest(
        `Unknown status "${new_status}". Valid statuses are: ${STATUS_SEQUENCE.join(', ')}.`
      );
    }
    if (!trimmedReason) {
      throw badRequest('A reason is required to change a submission status.');
    }
    if (trimmedReason.length > MAX_REASON_LENGTH) {
      throw badRequest(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }

    // Read, validate, update and log as one unit: either the status change and
    // its history row both persist, or neither does.
    const advance = db.transaction(() => {
      const current = db
        .prepare('SELECT submission_id, status FROM submissions WHERE submission_id = ?')
        .get(id);

      if (!current) {
        throw new RequestError(404, `No submission found with id ${id}.`);
      }

      const expected = nextStatus(current.status);

      if (new_status !== expected) {
        if (expected === null) {
          throw badRequest(
            `Submission ${id} is already at the final status "${current.status}" and cannot change.`
          );
        }
        if (new_status === current.status) {
          throw badRequest(`Submission ${id} is already "${current.status}".`);
        }
        throw badRequest(
          `Cannot change submission ${id} from "${current.status}" to "${new_status}". ` +
            `The only allowed next status is "${expected}".`
        );
      }

      // SQLite does not maintain updated_at on its own, so set it explicitly.
      db.prepare(`
        UPDATE submissions
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE submission_id = ?
      `).run(new_status, id);

      // changed_by stays NULL because there is no authentication yet.
      db.prepare(`
        INSERT INTO status_history
          (submission_id, old_status, new_status, reason, changed_by)
        VALUES (?, ?, ?, ?, NULL)
      `).run(id, current.status, new_status, trimmedReason);

      return db
        .prepare('SELECT * FROM submissions WHERE submission_id = ?')
        .get(id);
    });

    res.json(advance());
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`PATCH /submissions/${req.params.id}/status failed:`, error);
    res.status(500).json({ error: 'Could not update the submission status.' });
  }
});

// Terminal error handler: keeps every response JSON, including for a malformed
// request body, and never exposes internal error details to the client.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof RequestError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
