# Grievance-Redressal-Platform
University Complaint & Request Management Platform
An end-to-end web application built to streamline campus grievances, infrastructure service requests, and general student complaints. Beyond standard ticketing functionality, this project focuses heavily on foundational system design principles—specifically structural anonymity, timestamp bucketing privacy, and transparent lifecycle tracking.

This repository serves as both a working functional prototype and a hands-on architectural learning project for database design, decoupled submission workflows, and secure data handling.

About
In traditional university ticketing systems, student privacy is often handled as an afterthought—typically implemented as a simple boolean flag on a centralized record row. This platform flips that paradigm by establishing a strict architectural separation between identity and content.

Whether filing a targeted service request (e.g., plumbing or electrical repairs in a specific room) or a broader general complaint (e.g., hostel mess quality), students can submit issues anonymously or openly. Anonymous submissions utilize opaque, non-reversible tokens, metadata stripping, and timestamp bucketing to ensure absolute privacy safeguards.

Key Features
Dual Submission Workflows: Differentiates between linear Service Requests (routed to specific known departments) and non-linear General Complaints.

Structural Anonymity: Decouples user identity from submission payloads using cryptographic-style opaque tokens stored in isolated database schemas, preventing common accidental data leaks.

Privacy Protections: Features server-side timestamp bucketing for anonymous posts and a lightweight NLP name-redaction safety net (powered by compromise) to filter out sensitive contextual identifiers.

Private Token Receipts: Allows submitters to securely check status updates later without needing to register or maintain persistent user accounts.

Transparent Lifecycle Tracking: Moves each item through a defined state machine (submitted → acknowledged → in_progress → pending_council_review → resolved → closed) accompanied by a public audit history trail.

Tech Stack
Frontend: React, Vite

Backend: Node.js, Express

Database: SQLite (via better-sqlite3)

NLP / Text Processing: compromise (lightweight local entity extraction)

Development Environment: WSL2 / Ubuntu, version-controlled via Git and assisted via OpenCode AI coding agents.

Installation & Prerequisites
To run this project locally, ensure you have the following installed on your machine (or inside a WSL2 environment):

Node.js (v18+ recommended)

npm or yarn

Step-by-Step Setup
Clone the repository:

Bash
git clone https://github.com/your-username/university-complaint-platform.git
cd university-complaint-platform
Install backend dependencies:

Bash
cd backend
npm install
Install frontend dependencies:

Bash
cd ../frontend
npm install
Initialize and run the application:

Start the backend server:

Bash
cd backend
npm run dev
In a separate terminal, start the frontend client:

Bash
cd frontend
npm run dev
Usage Examples
Filing a Request: Navigate to the home dashboard, select either Service Request or General Complaint, fill out the category and location fields, and check Submit Anonymously if desired.

Tracking via Token: Upon successful submission, copy your private tracking token receipt to look up progress on the tracking portal without an account.

Roadmap & Current Status
[x] Core database schema & CRUD endpoints

[x] Student submission frontend (Service requests & General complaints)

[x] Structural anonymity token layer & timestamp bucketing

[x] Lightweight NLP in-text name redaction pipeline

[ ] Role-Based Access Control (RBAC) for staff and council layers (Pending)

[ ] Department triage routing and bounce-back workflow (Pending)

[ ] Duplicate complaint clustering engine (Planned)

Contributing
Contributions, feature suggestions, and architectural critiques are welcome! Since this is an active learning and development project, please follow these steps to contribute:

Fork the project.

Create your feature branch (git checkout -b feature/AmazingFeature).

Commit your changes (git commit -m 'Add some AmazingFeature').

Push to the branch (git push origin feature/AmazingFeature).

Open a Pull Request.
