# System Design: University Complaint & Request Management Platform

A reference document covering domain modeling, anonymity engineering, clustering safeguards, routing, interface architecture, and generalization to other organizations.

---

## 1. Core Domain Model: Requests vs. Complaints

Treat these as two related but distinct entity types rather than one generic "ticket."

| Dimension | Service Request | General Complaint |
|---|---|---|
| Target | Specific department (known) | Broad issue (department often unclear) |
| Lifecycle | Linear: submit → assign → act → close | Non-linear: submit → triage → possibly cluster → investigate → close |
| Ownership | Single department | May span multiple departments |
| Urgency signaling | Often explicit (e.g., "leaking pipe") | Often implicit, needs classification |

Both should share a common base entity (submission ID, timestamp, anonymity flag, status, category, attachments) but branch into type-specific metadata. This separation matters later for routing and clustering logic — you don't want to cluster a "broken tap in Room 214" request against a "mess food quality has declined" complaint just because both are unresolved.

---

## 2. Anonymity: Designing for Absolute Guarantees

This is the requirement where sloppy design does the most damage, so treat it as a security problem, not a feature toggle.

### 2.1 Structural separation of identity from content

The core principle: **identity should never be a property of the submission record — it should live in a separate, access-controlled store, linked only by an opaque token.**

- When a user submits anonymously, the system generates a random, non-reversible submission token. The submission record (text, category, attachments, status) is stored keyed to this token.
- A separate "authentication mapping" table links the token to the real user *only if* needed for legitimate purposes (e.g., allowing the user to check their own submission's status, or, in narrow cases, allowing a designated escalation authority to unmask identity under a defined policy — e.g., credible threat of harm).
- No join should exist in normal query paths between the submission table and the identity table. Anonymity shouldn't depend on an admin remembering not to query a field — it should be architecturally impossible in the common path, with any exception requiring a distinct, audited, higher-privilege operation.

### 2.2 Metadata leakage — the harder half of the problem

Absolute anonymity guarantees fail most often not through the text content but through metadata:

- **Timestamps**: If only one student was in a building at a given time, a precise timestamp can deanonymize. Mitigate by bucketing timestamps (e.g., to the nearest hour) for anonymous submissions.
- **IP addresses / device fingerprints**: Must not be logged in any table joinable to the submission, or must be discarded after basic abuse-rate-limiting checks.
- **Attachment metadata**: Photos can carry EXIF data (GPS coordinates, device ID). Strip all metadata from uploaded files server-side before storage.
- **Writing style**: Out of scope for automated defense, but worth documenting as a known residual risk — stylometric identification is a real (if advanced) threat vector.

### 2.3 In-text name redaction

Even if the *submitter's* identity is hidden, the complaint text itself might name other people ("Warden X was rude to me"), which raises its own privacy and fairness concerns.

Recommended two-stage pipeline:

1. **Automated detection pass**: Run a named-entity recognition step over submitted text to flag likely person names (and possibly room/ID numbers that could indirectly identify someone).
2. **Human-reviewable redaction, not silent auto-deletion**: Flag names for masking (e.g., "Warden [REDACTED]") and show the submitter a preview before final submission, or route ambiguous cases to a moderator queue.
3. **Fail-safe bias**: When detection confidence is low, err toward flagging for review rather than passing text through unredacted — the cost of a false positive (an unnecessary review) is much lower than a false negative (an identity leak).

**Key design lesson**: "Absolute certainty" in an engineering sense usually means "no path exists in the architecture to leak the data," not "the ML model is 100% accurate." The guarantee comes from structural separation (2.1) plus a human-in-the-loop safety net for content-level risks — never from over-trusting the NER model.

---

## 3. Duplicate and Related-Complaint Clustering

### 3.1 Why naive clustering fails

A naive approach (e.g., pure text-similarity thresholding) tends to conflate:
- **Genuinely duplicate complaints** ("mess food is cold" x40 today)
- **Related but distinct complaints** ("mess food is cold" vs. "mess food has hygiene issues") — same domain, different root cause
- **Coincidentally similar but unrelated complaints** (two different bathrooms both "smell bad")

Merging the second and third categories incorrectly suppresses signals administrators need to act on separately.

### 3.2 A safer clustering design

- **Two-tier grouping**: (a) a loose "topic cluster" (department + category + rough semantic similarity, used only for dashboard trend visualization) and (b) a strict "duplicate" designation (used to actually merge complaint counts), requiring higher similarity confidence plus matching structured metadata (same location, same category, submitted within a tight time window).
- **Never auto-merge silently.** Present clustering as a *suggestion* surfaced to an administrator/moderator ("12 complaints appear related — review and confirm grouping?") rather than an automatic, irreversible merge. This keeps a human accountable and gives you an audit trail if a merge turns out wrong.
- **Confidence thresholds with a middle band**: high-confidence auto-suggest, low-confidence ignore, and a middle band queued for manual review.
- **Allow de-merging**: Support splitting a cluster back apart if a moderator later realizes distinct issues were bundled.
- **Structured fields do more work than free text**: Capturing department, building, room/block, category as structured fields improves clustering accuracy and is easier to reason about than relying purely on NLP similarity — which is the most common source of false-positive merges in real systems.

---

## 4. Handling Unclear Department Routing

Two instincts to avoid: forcing a rigid category selection (frustrates users, produces mis-tagged data) and dumping everything into a single unsorted inbox (creates a black hole where nothing gets owned).

Recommended pattern — a **triage layer**:

1. **Soft-required categorization at submission**: Ask for a best-guess category, but always offer an "Unsure / General" option rather than blocking submission.
2. **Suggested routing, not forced routing**: Use the complaint text (keywords, or a lightweight classifier) to *suggest* a likely department before submission, which the user can accept or override.
3. **A triage/coordination role**: Complaints landing in "Unsure" or rejected by a department as "not ours" go to a designated triage function (rotating administrative role or student council liaison) whose job is specifically re-routing, not resolving.
4. **Bounce-back accountability**: If a department marks a complaint as "wrong department," that action requires a redirect target and a reason, visible in the complaint's public history — discourages misrouting as an avoidance tactic and gives triage clear signal when routing suggestions are systematically wrong.

---

## 5. Unified Platform vs. Separate Interfaces

### Separate student and administration applications

**Advantages**: purpose-built, lean interfaces; easier to reason about security boundaries at the deployment level; reduces risk of accidentally exposing admin-only data through a shared client.

**Disadvantages**: duplicated engineering effort for shared concepts (status, comments, attachments); harder to keep feature parity and data consistency; transparency features (public status boards) become awkward since they need to pull from an architecturally separate system.

### Unified platform with role-based views

**Advantages**: single source of truth for complaint state (critical for transparency and audit requirements); public status tracking is a natural extension rather than a separate integration; role-based access control (RBAC) is a well-understood pattern — define roles (student/submitter, department staff, triage, student council, super-admin) and permission sets per role.

**Disadvantages**: requires more careful access-control engineering up front, since a bug in role-checking logic can expose data across roles in a single shared system; anonymity protections must be enforced consistently across every view.

**Recommendation**: A unified platform with RBAC is generally the stronger choice, specifically because the requirements (public status tracking, council approval workflow, active-vs-unaddressed visibility) all depend on a single consistent state model. The added access-control complexity is worth trading for avoiding data-consistency and duplication problems — but anonymity guarantees (Section 2) must be treated as platform-wide invariants, not isolated to one interface.

### Transparency features within the unified model

- **Public status tracking**: Every complaint (barring ones flagged sensitive, e.g., harassment allegations) gets a status visible to all users — e.g., *Submitted → Acknowledged → In Progress → Pending Council Review → Resolved/Closed*.
- **Active vs. unaddressed visibility**: Distinguish complaints with *no department response yet* from those *actively being worked on*, e.g. via a "last updated" signal — valuable for accountability and for preventing duplicate submissions.
- **Closure requiring council approval**: A department proposes resolution with a documented reason, but the complaint only transitions to "Closed" after a council-role approval action, logged with approver identity and timestamp — a two-party accountability check with a permanent audit trail.

---

## 6. Generalizing to Other Organizational Contexts

The core architectural patterns are largely domain-agnostic — what changes is the taxonomy and the approval hierarchy, not the underlying design.

| University concept | Corporate/hierarchical equivalent |
|---|---|
| Department (cleaning, repairs) | Business unit / facilities / IT / HR |
| Student council approval | HR or compliance sign-off, ombudsperson review |
| Mess food / safety complaints | Workplace safety, harassment, facilities complaints |
| Triage for unclear routing | Central helpdesk / shared services intake |
| Anonymity for students | Whistleblower protections — often with *stronger* legal requirements |

Two adaptations worth noting:

1. **Escalation hierarchy becomes more layered.** A university has roughly two tiers (department, student council); a corporation often needs multi-level escalation (team lead → department → HR/compliance → executive), so the closure-approval workflow should be modeled as a configurable chain rather than a hardcoded single approver role.
2. **Anonymity requirements often become legally binding.** Many corporate/government contexts have statutory whistleblower-anonymity requirements, raising the bar from "best-effort design" to "must be defensible in an audit or legal proceeding." The human-in-the-loop redaction review process (2.3) becomes more important to document formally.

The clustering and triage patterns translate directly — "duplicate IT tickets" and "duplicate facility complaints" are the same problem shape as duplicate mess-food complaints.

---

## Summary of Key Design Principles

1. **Anonymity is structural, not procedural** — separate identity from content at the data-model level, don't rely on access-control discipline alone.
2. **Automated decisions (redaction, clustering) should default to human review at low confidence**, not silent action.
3. **Clustering should distinguish "trend visualization" from "hard duplicate merging"** — different risk tolerances.
4. **Routing ambiguity needs an owned triage function**, not a black-hole queue.
5. **A unified, role-based platform is usually the better foundation for transparency and audit requirements.**
6. **Multi-party closure (proposer + approver) is a general accountability pattern** that generalizes beyond universities.

---

## Appendix: A Suggested Build Path (for learning by building)

A reasonable order to tackle this hands-on, roughly easiest/most-foundational to hardest:

1. **Data model & core CRUD** — submissions, departments, categories, status enum. Get requests and complaints stored and retrievable before anything clever.
2. **RBAC & auth** — roles (student, department staff, triage, council, admin) and permission checks. This underpins everything else, including anonymity.
3. **Anonymity token layer** — separate identity store, opaque submission tokens, no default joins. Build this early since retrofitting anonymity onto an existing schema is painful.
4. **Status workflow & public tracking** — the state machine (Submitted → Acknowledged → In Progress → Pending Council Review → Resolved/Closed) plus a public read-only view.
5. **Triage/routing** — "Unsure" category, suggested routing, bounce-back with reason.
6. **Closure approval workflow** — propose-then-approve, audit log of approver + reason.
7. **Redaction pipeline** — NER-based name flagging with human review queue (this is the most "AI-flavored" piece and pairs well with learning basic NLP tooling).
8. **Clustering** — start with structured-field-based grouping (same category + location + time window) before introducing text-similarity clustering; add the suggest-don't-auto-merge review UI last.

Each stage is independently demo-able, which makes it easier to learn incrementally rather than trying to build the whole system at once.
