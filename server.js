const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// DB
const db = new Database("data.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(issue_id, agent_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  issue_id INTEGER,
  agent_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Roles for coordination
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL, -- Lead | Reviewer | Observer
  created_at TEXT NOT NULL,
  UNIQUE(issue_id, agent_id)
);
`);

function nowISO() { return new Date().toISOString(); }

function addFeed({ type, issue_id = null, agent_id = null, text }) {
  db.prepare(
    `INSERT INTO feed(type, issue_id, agent_id, text, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(type, issue_id, agent_id, text, nowISO());
}

// --- Uploads setup (jpg/png/webp/gif) ---
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeExt = (file.originalname.split(".").pop() || "").toLowerCase();
    const allowedExt = ["jpg", "jpeg", "png", "webp", "gif"];
    const ext = allowedExt.includes(safeExt) ? safeExt : "bin";
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const okTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const ok = okTypes.includes(file.mimetype);
    cb(ok ? null : new Error("Only jpg/png/webp/gif allowed"), ok);
  }
});

app.use("/uploads", express.static(UPLOAD_DIR));

app.post("/api/uploads", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url });
});

// --- API ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowISO() });
});

// Join and get role (Lead/Reviewer/Observer)
app.post("/api/issues/:id/join", (req, res) => {
  const issue_id = Number(req.params.id);
  const { agent_id } = req.body || {};
  if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

  const issue = db.prepare(`SELECT * FROM issues WHERE id=?`).get(issue_id);
  if (!issue) return res.status(404).json({ error: "issue not found" });

  const existing = db.prepare(`SELECT role FROM roles WHERE issue_id=? AND agent_id=?`)
    .get(issue_id, String(agent_id));
  if (existing) return res.json({ issue_id, agent_id: String(agent_id), role: existing.role });

  const current = db.prepare(`SELECT role FROM roles WHERE issue_id=? ORDER BY id ASC`).all(issue_id);
  const hasLead = current.some(r => r.role === "Lead");
  const hasReviewer = current.some(r => r.role === "Reviewer");

  let role = "Observer";
  if (!hasLead) role = "Lead";
  else if (!hasReviewer) role = "Reviewer";

  db.prepare(`INSERT INTO roles(issue_id, agent_id, role, created_at) VALUES (?, ?, ?, ?)`)
    .run(issue_id, String(agent_id), role, nowISO());

  addFeed({ type: "system", issue_id, agent_id: String(agent_id), text: `${agent_id} joined as ${role}` });
  res.json({ issue_id, agent_id: String(agent_id), role });
});

app.get("/api/issues/:id/roles", (req, res) => {
  const issue_id = Number(req.params.id);
  const rows = db.prepare(`SELECT agent_id, role, created_at FROM roles WHERE issue_id=? ORDER BY id ASC`).all(issue_id);
  res.json(rows);
});

app.post("/api/issues", (req, res) => {
  const { title, context, image_url = null } = req.body || {};
  if (!title || !context) return res.status(400).json({ error: "title and context are required" });

  const info = db.prepare(
    `INSERT INTO issues(title, context, image_url, status, created_at)
     VALUES (?, ?, ?, 'open', ?)`
  ).run(title.trim(), context.trim(), image_url, nowISO());

  addFeed({ type: "issue", issue_id: info.lastInsertRowid, text: `New issue created: ${title.trim()}` });
  res.json({ id: info.lastInsertRowid });
});

app.get("/api/issues", (req, res) => {
  const rows = db.prepare(`SELECT * FROM issues ORDER BY id DESC LIMIT 100`).all();

  const out = rows.map((it) => {
    const latest = db.prepare(`SELECT * FROM proposals WHERE issue_id=? ORDER BY id DESC LIMIT 1`).get(it.id);
    let agreed_by = [];
    if (latest) {
      const agrees = db.prepare(`SELECT agent_id FROM agreements WHERE issue_id=? AND proposal_id=? ORDER BY id ASC`).all(it.id, latest.id);
      agreed_by = agrees.map(a => a.agent_id);
    }
    return { ...it, latest_proposal: latest || null, agreed_by };
  });

  res.json(out);
});

app.get("/api/issues/:id", (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare(`SELECT * FROM issues WHERE id=?`).get(id);
  if (!issue) return res.status(404).json({ error: "issue not found" });
  const proposals = db.prepare(`SELECT * FROM proposals WHERE issue_id=? ORDER BY id ASC`).all(id);
  res.json({ issue, proposals });
});

app.post("/api/issues/:id/proposals", (req, res) => {
  const issue_id = Number(req.params.id);
  const issue = db.prepare(`SELECT * FROM issues WHERE id=?`).get(issue_id);
  if (!issue) return res.status(404).json({ error: "issue not found" });
  if (issue.status === "agreed") return res.status(409).json({ error: "issue already agreed" });

  const { agent_id, kind = "proposal", message, decision } = req.body || {};
  if (!agent_id || !message || !decision) {
    return res.status(400).json({ error: "agent_id, message, decision are required" });
  }

  for (const k of ["priority","owner","due","action","qc_check"]) {
    if (!(k in decision)) return res.status(400).json({ error: `decision.${k} is required` });
  }

  const info = db.prepare(
    `INSERT INTO proposals(issue_id, agent_id, kind, message, decision_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    issue_id,
    String(agent_id),
    kind === "counter" ? "counter" : "proposal",
    String(message),
    JSON.stringify(decision),
    nowISO()
  );

  addFeed({ type: "proposal", issue_id, agent_id: String(agent_id), text: `${agent_id} posted a ${kind} on issue #${issue_id}` });
  res.json({ proposal_id: info.lastInsertRowid });
});

app.post("/api/issues/:id/agree", (req, res) => {
  const issue_id = Number(req.params.id);
  const { agent_id, proposal_id } = req.body || {};
  if (!agent_id || !proposal_id) return res.status(400).json({ error: "agent_id and proposal_id are required" });

  const issue = db.prepare(`SELECT * FROM issues WHERE id=?`).get(issue_id);
  if (!issue) return res.status(404).json({ error: "issue not found" });

  const prop = db.prepare(`SELECT * FROM proposals WHERE id=? AND issue_id=?`).get(Number(proposal_id), issue_id);
  if (!prop) return res.status(404).json({ error: "proposal not found for this issue" });

  // Reviewer constraint: must ask at least 2 questions before agreeing
  const roleRow = db.prepare(`SELECT role FROM roles WHERE issue_id=? AND agent_id=?`).get(issue_id, String(agent_id));
  const role = roleRow?.role || "Observer";

  if (role === "Reviewer") {
    const msgs = db.prepare(`SELECT message FROM proposals WHERE issue_id=? AND agent_id=?`).all(issue_id, String(agent_id));
    const qCount = msgs.reduce((sum, r) => sum + ((r.message || "").match(/\?/g) || []).length, 0);
    if (qCount < 2) {
      return res.status(400).json({ error: "Reviewer must ask at least 2 questions (include '?') before agreeing." });
    }
  }

  try {
    db.prepare(
      `INSERT INTO agreements(issue_id, agent_id, proposal_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(issue_id, String(agent_id), Number(proposal_id), nowISO());
  } catch (e) {
    return res.status(409).json({ error: "already agreed by this agent" });
  }

  addFeed({ type: "agree", issue_id, agent_id: String(agent_id), text: `${agent_id} agreed to proposal #${proposal_id} on issue #${issue_id}` });

  const agrees = db.prepare(`SELECT agent_id FROM agreements WHERE issue_id=? AND proposal_id=?`).all(issue_id, Number(proposal_id));
  if (agrees.length >= 2) {
    db.prepare(`UPDATE issues SET status='agreed' WHERE id=?`).run(issue_id);
    addFeed({ type: "system", issue_id, text: `✅ Issue #${issue_id} AGREED on proposal #${proposal_id} by ${agrees.map(a => a.agent_id).join(", ")}` });
    return res.json({ ok: true, agreed: true, agreed_by: agrees.map(a => a.agent_id), role });
  }

  res.json({ ok: true, agreed: false, agreed_by: agrees.map(a => a.agent_id), role });
});

app.get("/api/feed", (req, res) => {
  const rows = db.prepare(`SELECT * FROM feed ORDER BY id DESC LIMIT 200`).all();
  res.json(rows);
});

// --- UI (static) ---
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
