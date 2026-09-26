const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// Get all submissions
app.get('/submissions', (req, res) => {
  try {
    const submissions = db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new submission
app.post('/submissions', (req, res) => {
  const { submission_type, title, description, category_id, department_id, location, is_anonymous } = req.body;
  
  try {
    const insert = db.prepare(`
      INSERT INTO submissions 
      (submission_type, title, description, category_id, department_id, location, is_anonymous) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    // Convert boolean to integer for SQLite
    const anonymousFlag = is_anonymous ? 1 : 0;
    
    const info = insert.run(
      submission_type, 
      title, 
      description, 
      category_id || null, 
      department_id || null,
      location || null,
      anonymousFlag
    );
    
    // Log the initial status in history
    const historyInsert = db.prepare(`
      INSERT INTO status_history (submission_id, new_status, reason)
      VALUES (?, 'submitted', 'Initial submission via API')
    `);
    historyInsert.run(info.lastInsertRowid);
    
    res.status(201).json({ id: info.lastInsertRowid, message: "Submission successful" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
