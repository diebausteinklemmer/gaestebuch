/**
 * Gästebuch Backend (Option A): Moderation + SQLite + (optional) Email
 * Lokal:   node index.js  -> http://localhost:3000
 * Online:  Railway/Hoster -> nutzt process.env.PORT und persistiert DB auf /data (Volume)
 */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");

const app = express();

/** ========= KONFIG ========= */

// Railway setzt PORT automatisch
const PORT = process.env.PORT || 3000;

// Unterstützt beide Varianten: PUBLIC_BASE_URL (neu) und BASE_URL (dein .env)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// Admin-Schutz: unterstützt ADMIN_TOKEN (neu) und MOD_SECRET (dein .env)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.MOD_SECRET || "DEV_TOKEN_CHANGE_ME";

// Mail: unterstützt MAIL_TO (neu) und ADMIN_EMAIL (dein .env)
const MAIL_TO = process.env.MAIL_TO || process.env.ADMIN_EMAIL || "info@diebausteinklemmer.de";

// From: unterstützt MAIL_FROM (neu) und FROM_EMAIL (dein .env)
const MAIL_FROM = process.env.MAIL_FROM || process.env.FROM_EMAIL || "Die Bausteinklemmer <noreply@diebausteinklemmer.de>";

// SQLite Datei: lokal im Projekt, online auf /data (Volume Mount)
const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_ENVIRONMENT
    ? "/data/guestbook.db"
    : path.join(__dirname, "guestbook.db"));

// CORS: später auf deine Domain einschränken
app.use(cors());
app.use(express.json({ limit: "50kb" }));

/** ========= DB ========= */
const db = new Database(DB_PATH);

// Tabellen anlegen
db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_status_created ON entries(status, created_at);
`);

// prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO entries (name, message, status, created_at)
  VALUES (@name, @message, 'pending', @created_at)
`);

const stmtApproved = db.prepare(`
  SELECT id, name, message, created_at
  FROM entries
  WHERE status='approved'
  ORDER BY id DESC
  LIMIT 50
`);

const stmtPending = db.prepare(`
  SELECT id, name, message, status, created_at
  FROM entries
  WHERE status='pending'
  ORDER BY id DESC
`);

const stmtSetStatus = db.prepare(`
  UPDATE entries SET status=@status WHERE id=@id
`);

/** ========= Email (optional) ========= */

// kleine Helfer fürs sichere Parsen
function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function hasSmtp() {
  // wichtig: trim(), sonst reichen Leerzeichen und es wirkt "gesetzt"
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  return !!(host && user && pass);
}

function getTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);

  // Unterstützt:
  // - SMTP_SECURE=true/false (dein .env)
  // - Fallback: Port 465 => secure, sonst false
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? toBool(process.env.SMTP_SECURE, port === 465)
      : port === 465;

  return nodemailer.createTransport({
    host: String(process.env.SMTP_HOST || "").trim(),
    port,
    secure,
    auth: {
      user: String(process.env.SMTP_USER || "").trim(),
      pass: String(process.env.SMTP_PASS || "").trim(),
    },
  });
}

// Klarer Start-Log (ohne Passwort)
function logEnvStatus() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const port = String(process.env.SMTP_PORT || "").trim();
  const sec = String(process.env.SMTP_SECURE || "").trim();

  console.log("— ENV Check —");
  console.log("PUBLIC_BASE_URL:", PUBLIC_BASE_URL);
  console.log(
    "ADMIN_TOKEN:",
    ADMIN_TOKEN === "DEV_TOKEN_CHANGE_ME" ? "(DEV default - bitte setzen)" : "(gesetzt)"
  );
  console.log("SMTP_HOST:", host ? "✅ gesetzt" : "❌ fehlt/leer");
  console.log("SMTP_PORT:", port ? `✅ ${port}` : "ℹ️ leer (Fallback 587)");
  console.log("SMTP_SECURE:", sec ? `✅ ${sec}` : "ℹ️ leer (Fallback über Port)");
  console.log("SMTP_USER:", user ? "✅ gesetzt" : "❌ fehlt/leer");
  console.log("SMTP_PASS:", pass ? `✅ gesetzt (len ${pass.length})` : "❌ fehlt/leer");
  console.log("MAIL_FROM:", MAIL_FROM);
  console.log("MAIL_TO:", MAIL_TO);
  console.log("— /ENV Check —");
}

// ✅ Einmaliger SMTP-Check beim Start
async function verifySmtpOnStartup() {
  logEnvStatus();

  if (!hasSmtp()) {
    console.log("✉️  SMTP: deaktiviert (SMTP_HOST/SMTP_USER/SMTP_PASS fehlt oder leer)");
    return;
  }

  try {
    const transporter = getTransporter();
    await transporter.verify();
    console.log("✅ SMTP bereit (Login ok)");
  } catch (err) {
    console.error("❌ SMTP Problem:", err?.code || "", err?.message || err);
    console.log("Tipps:");
    console.log("- Gmail App-Passwort (16 Zeichen) wirklich in SMTP_PASS?");
    console.log("- Keine Anführungszeichen im .env bei SMTP_PASS (nur roh einfügen).");
    console.log("- Port 465 => SMTP_SECURE=true, Port 587 => SMTP_SECURE=false (STARTTLS).");
    console.log("- .env gespeichert? Server neu gestartet? (node index.js)");
  }
}

function buildMailHtml({ name, message, created_at, approve_url, reject_url }) {
  return `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;font-size:14px;line-height:1.5;color:#111827">
  <h2 style="margin:0 0 10px 0;font-size:18px;">🧱 Neuer Gästebuch-Eintrag (Freigabe nötig)</h2>

  <p style="margin:0 0 10px 0;">
    Ein neuer Eintrag wurde eingereicht und wartet auf deine Freigabe.
  </p>

  <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#f9fafb;margin:12px 0;">
    <p style="margin:0 0 6px 0;"><strong>Name:</strong> ${escapeHtml(name)}</p>
    <p style="margin:0 0 6px 0;"><strong>Nachricht:</strong><br>${escapeHtml(message)}</p>
    <p style="margin:0;"><strong>Zeit:</strong> ${escapeHtml(created_at)}</p>
  </div>

  <p style="margin:14px 0 6px 0;"><strong>✅ Freigeben:</strong></p>
  <p style="margin:0 0 10px 0;">
    <a href="${approve_url}" style="display:inline-block;background:#16a34a;color:white;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:700;">
      Eintrag freigeben
    </a>
  </p>

  <p style="margin:10px 0 6px 0;"><strong>❌ Ablehnen/Löschen:</strong></p>
  <p style="margin:0 0 14px 0;">
    <a href="${reject_url}" style="display:inline-block;background:#dc2626;color:white;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:700;">
      Eintrag ablehnen
    </a>
  </p>

  <p style="margin:0;color:#6b7280;font-size:12px;">
    Hinweis: Bitte nur klicken, wenn du den Eintrag wirklich so veröffentlichen willst.
  </p>
</div>
`.trim();
}

async function sendModerationMail(entry) {
  if (!hasSmtp()) return;

  const approve_url = `${PUBLIC_BASE_URL}/admin/approve?id=${entry.id}&token=${encodeURIComponent(
    ADMIN_TOKEN
  )}`;
  const reject_url = `${PUBLIC_BASE_URL}/admin/reject?id=${entry.id}&token=${encodeURIComponent(
    ADMIN_TOKEN
  )}`;

  const transporter = getTransporter();

  await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject: "🧱 Neuer Gästebuch-Eintrag (Freigabe nötig)",
    html: buildMailHtml({ ...entry, approve_url, reject_url }),
  });
}

/** ========= Helfer ========= */
function nowIso() {
  return new Date().toISOString();
}

function requireAdmin(req, res, next) {
  const token =
    req.query.token ||
    (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);

  if (token !== ADMIN_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(str, maxLen) {
  const s = String(str || "").trim();
  if (!s) return "";
  // einfache Normalisierung + harte Längenbegrenzung
  return s.replace(/\s+/g, " ").slice(0, maxLen);
}

/** ========= API ========= */

// public: approved entries
app.get("/api/entries", (req, res) => {
  const rows = stmtApproved.all();
  res.json(rows);
});

// submit: pending entry
app.post("/api/entries", async (req, res) => {
  const name = cleanText(req.body?.name, 40);
  const message = cleanText(req.body?.message, 400);

  if (!name || !message) {
    return res.status(400).json({ ok: false, error: "Name und Nachricht sind Pflicht." });
  }

  const entry = {
    name,
    message,
    created_at: nowIso(),
  };

  const info = stmtInsert.run(entry);
  const created = { id: info.lastInsertRowid, ...entry };

  // optional: email an admin
  try {
    await sendModerationMail(created);
    console.log(`✉️  Moderations-Mail gesendet für Eintrag #${created.id}`);
  } catch (e) {
    // Mail darf nie den Eintrag blocken
    console.error("Mail error:", e?.code || "", e?.message || e);
  }

  res.json({ ok: true, id: created.id });
});

// admin: list pending
app.get("/admin/pending", requireAdmin, (req, res) => {
  const rows = stmtPending.all();
  res.json(rows);
});

// admin: approve
app.get("/admin/approve", requireAdmin, (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).send("Missing id");
  stmtSetStatus.run({ id, status: "approved" });
  res.send("✅ Freigegeben. Du kannst das Fenster schließen.");
});

// admin: reject
app.get("/admin/reject", requireAdmin, (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).send("Missing id");
  stmtSetStatus.run({ id, status: "rejected" });
  res.send("🗑️ Abgelehnt. Du kannst das Fenster schließen.");
});

/** ========= UI (einfaches lokales Frontend) =========
 * Das ist eine Mini-UI zum Testen. Später baust du das in deine Website ein.
 */
app.get("/", (req, res) => {
  res.type("html").send(
    `
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Gästebuch (lokal)</title>
  <style>
    :root{--bg:#0b1220;--panel:#0f172a;--text:#e5e7eb;--muted:#94a3b8;--brand:#22c55e;--radius:16px}
    body{margin:0;background:radial-gradient(1200px 700px at 20% 0%, #111b33, var(--bg));color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif}
    .wrap{max-width:900px;margin:40px auto;padding:0 16px}
    h1{margin:0 0 8px 0}
    .sub{color:var(--muted);margin:0 0 22px 0}
    .card{background:rgba(15,23,42,.78);border:1px solid rgba(148,163,184,.14);border-radius:var(--radius);padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    label{display:block;margin:12px 0 6px 0;color:var(--muted);font-weight:600}
    input,textarea{width:100%;background:#0b1220;border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:12px;color:var(--text);outline:none}
    textarea{min-height:120px;resize:vertical}
    button{margin-top:14px;background:var(--brand);border:none;color:#03200d;font-weight:800;padding:10px 14px;border-radius:12px;cursor:pointer}
    .list{margin-top:22px}
    .entry{padding:12px;border-radius:14px;border:1px solid rgba(148,163,184,.14);margin:10px 0;background:rgba(2,6,23,.35)}
    .meta{display:flex;gap:10px;justify-content:space-between;color:var(--muted);font-size:12px}
    .empty{color:var(--muted)}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🧱 Gästebuch (lokal) 🚀</h1>
    <p class="sub">Testumgebung auf <strong>localhost</strong>. Noch kein Internet, kein Cloud, alles safe.</p>

    <div class="card">
      <label>Name</label>
      <input id="name" placeholder="z.B. Muchacho 112"/>
      <label>Nachricht</label>
      <textarea id="msg" placeholder="Deine Nachricht..."></textarea>
      <button id="send">Eintrag senden</button>
      <p id="hint" class="sub" style="margin-top:12px"></p>
    </div>

    <div class="list">
      <h2 style="margin:20px 0 8px 0">📌 Einträge</h2>
      <div id="entries" class="empty">Lade...</div>
    </div>
  </div>

<script>
const $ = (id)=>document.getElementById(id);

async function loadEntries(){
  const r = await fetch('/api/entries');
  const data = await r.json();
  const box = $('entries');
  if(!data.length){
    box.className='empty';
    box.textContent='Noch keine freigegebenen Einträge. (Neue Einträge landen erstmal in der Moderation 😉)';
    return;
  }
  box.className='';
  box.innerHTML = data.map(e=>\`
    <div class="entry">
      <div class="meta"><strong>\${escapeHtml(e.name)}</strong><span>\${new Date(e.created_at).toLocaleString()}</span></div>
      <div style="margin-top:6px">\${escapeHtml(e.message)}</div>
    </div>\`
  ).join('');
}

function escapeHtml(s){
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");
}

$('send').onclick = async ()=>{
  $('hint').textContent='';
  const name = $('name').value.trim();
  const message = $('msg').value.trim();
  const r = await fetch('/api/entries', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name, message})
  });
  const out = await r.json().catch(()=>({ok:false}));
  if(!r.ok || !out.ok){
    $('hint').textContent = '❌ ' + (out.error || 'Fehler beim Senden');
    return;
  }
  $('hint').textContent = '✅ Eingereicht! (wartet auf Freigabe)';
  $('msg').value='';
  await loadEntries();
};

loadEntries();
</script>
</body>
</html>
  `.trim()
  );
});

/** ========= Start ========= */
app.listen(PORT, async () => {
  console.log(`Gästebuch läuft auf ${PUBLIC_BASE_URL} 🚀`);
  console.log(`DB: ${DB_PATH}`);

  // ✅ SMTP Start-Check
  await verifySmtpOnStartup();
});
