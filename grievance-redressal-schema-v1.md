# Grievance Redressal Project — Schema v1 (MySQL)

Scope: the first build slice only — departments, categories, submissions, and status history. No authentication or anonymity layer yet (that's a deliberate later stage, once you've got a working submit → view → status-update loop).

---

## 1. Tables

### `departments`
Owns service requests and complaints routed to them.

```sql
CREATE TABLE departments (
    department_id   INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    description     VARCHAR(255),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `categories`
Sub-classification within a submission type (e.g., "Plumbing", "Mess Food Quality").

```sql
CREATE TABLE categories (
    category_id     INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    submission_type ENUM('request', 'complaint') NOT NULL,
    department_id   INT,
    FOREIGN KEY (department_id) REFERENCES departments(department_id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);
```

*Design note:* `department_id` here is a **default/suggested** department for that category — not a hard binding. A category like "Mess Food Quality" might default to the Mess Committee but could still be manually routed elsewhere during triage.

### `users`
Kept minimal for now — no roles or anonymity handling yet.

```sql
CREATE TABLE users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `submissions`
The core table — both service requests and complaints live here, distinguished by `submission_type`.

```sql
CREATE TABLE submissions (
    submission_id   INT AUTO_INCREMENT PRIMARY KEY,
    submission_type ENUM('request', 'complaint') NOT NULL,
    title           VARCHAR(150) NOT NULL,
    description     TEXT NOT NULL,
    category_id     INT,
    department_id   INT,
    submitted_by    INT,
    status          ENUM('submitted', 'acknowledged', 'in_progress',
                          'pending_council_review', 'resolved', 'closed')
                          NOT NULL DEFAULT 'submitted',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (category_id) REFERENCES categories(category_id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    FOREIGN KEY (department_id) REFERENCES departments(department_id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    FOREIGN KEY (submitted_by) REFERENCES users(user_id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);
```

*Design notes:*
- `department_id` uses `ON DELETE RESTRICT` — you should not be able to delete a department while it still owns active submissions. This forces a deliberate reassignment step rather than silently orphaning data.
- `category_id` and `submitted_by` use `ON DELETE SET NULL` — losing a category or a user account shouldn't destroy the submission record itself, just null out that reference.
- `ON UPDATE CASCADE` everywhere — if a primary key value ever changes upstream (rare with `AUTO_INCREMENT`, but good practice), dependent rows follow automatically.

### `status_history`
An append-only audit trail. This is what powers "public status tracking" and "active vs. unaddressed" visibility later — you always know when a status changed and (eventually) who changed it.

```sql
CREATE TABLE status_history (
    history_id      INT AUTO_INCREMENT PRIMARY KEY,
    submission_id   INT NOT NULL,
    old_status      VARCHAR(30),
    new_status      VARCHAR(30) NOT NULL,
    changed_by      INT,
    reason          VARCHAR(255),
    changed_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (submission_id) REFERENCES submissions(submission_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (changed_by) REFERENCES users(user_id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);
```

*Design note:* `ON DELETE CASCADE` here — if a submission is ever deleted outright (should be rare/admin-only), its history log has no reason to exist independently, so it's cleaned up automatically.

---

## 2. Entity-relationship summary

```
departments (1) ───< categories (many)
departments (1) ───< submissions (many)
categories  (1) ───< submissions (many)
users       (1) ───< submissions (many)   [submitted_by]
submissions (1) ───< status_history (many)
users       (1) ───< status_history (many) [changed_by]
```

---

## 3. Sample queries you'll write against this schema

```sql
-- All open complaints in a department, newest first
SELECT s.title, s.status, s.created_at
FROM submissions s
JOIN departments d ON s.department_id = d.department_id
WHERE d.name = 'Hostel Maintenance' AND s.status != 'closed'
ORDER BY s.created_at DESC;

-- Count of submissions per department (trend dashboard)
SELECT d.name, COUNT(*) AS total_submissions
FROM submissions s
JOIN departments d ON s.department_id = d.department_id
GROUP BY d.name
ORDER BY total_submissions DESC;

-- Average time-to-first-response, using status_history
SELECT s.submission_id,
       TIMESTAMPDIFF(HOUR, s.created_at, MIN(h.changed_at)) AS hours_to_ack
FROM submissions s
JOIN status_history h ON s.submission_id = h.submission_id
WHERE h.new_status = 'acknowledged'
GROUP BY s.submission_id;
```
