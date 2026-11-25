const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const STRICT = process.env.STRICT_NETWORK === '1'; // enforce "same Wi-Fi/hotspot" check
const LATE_MIN = +process.env.LATE_MIN || 10;       // minutes after start => "Late"
const STEP = 20;                                    // code changes every 20 seconds

const db = new Database('attendance.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, roll TEXT UNIQUE, name TEXT, role TEXT, hash TEXT, device TEXT);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, teacher_id INT, subject TEXT, secret TEXT, subnet TEXT, started INT, ends INT, open INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS records(session_id INT, student_id INT, status TEXT, ip TEXT, device TEXT, ts INT, PRIMARY KEY(session_id, student_id));
`);

const userColumns = new Set(db.pragma('table_info(users)').map(column => column.name));
for (const [column, definition] of [['email', 'TEXT'], ['department', 'TEXT'], ['class_division', 'TEXT']]) {
  if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS users_roll_nocase_unique ON users(roll COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_nocase_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
`);

const tokens = new Map(); // login token -> {id, role}
const ipOf = r => (r.ip || '').replace('::ffff:', '');
const subnet = ip => ip.split('.').slice(0, 3).join('.'); // same /24 = same hotspot/Wi-Fi
const win = () => Math.floor(Date.now() / 1000 / STEP);
const codeFor = (secret, w) =>
  String(crypto.createHmac('sha256', secret).update(String(w)).digest().readUInt32BE(0) % 1000000).padStart(6, '0');
const openSessions = () => {
  db.prepare('UPDATE sessions SET open=0 WHERE open=1 AND ends<?').run(Date.now());
  return db.prepare('SELECT * FROM sessions WHERE open=1').all();
};
const auth = role => (req, res, next) => {
  const u = tokens.get((req.headers.authorization || '').slice(7));
  if (!u || (role && u.role !== role)) return res.status(401).json({ error: 'Please log in again.' });
  req.user = u; next();
};
const report = (where, args) => db.prepare(`
  SELECT u.id, u.roll, u.name, s.subject, COUNT(s.id) total,
         SUM(CASE WHEN r.status IN ('P','L') THEN 1 ELSE 0 END) attended
  FROM users u CROSS JOIN sessions s
  LEFT JOIN records r ON r.session_id = s.id AND r.student_id = u.id
  WHERE u.role = 'student' ${where} GROUP BY u.id, s.subject ORDER BY u.roll, s.subject`).all(...args);

const app = express();
app.use(express.json());
app.use(express.static('public'));

function registerUser(role) {
  return (req, res) => {
    const body = req.body || {};
    const { name, email, department, password, confirmPassword } = body;
    const rawIdentifier = role === 'teacher' ? body.teacherId : body.studentRoll;
    const identifier = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : '';
    const fullName = String(name || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedDepartment = String(department || '').trim();
    const classDivision = String(body.classDivision || '').trim();

    if (!identifier || !fullName || !normalizedEmail || !normalizedDepartment ||
        typeof password !== 'string' || !password || typeof confirmPassword !== 'string' || !confirmPassword ||
        (role === 'student' && !classDivision))
      return res.status(400).json({ error: 'Please complete all required fields.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password !== confirmPassword)
      return res.status(400).json({ error: 'The passwords do not match.' });
    if (db.prepare('SELECT 1 FROM users WHERE roll=? COLLATE NOCASE OR email=? COLLATE NOCASE').get(identifier, normalizedEmail))
      return res.status(409).json({ error: 'That ID or email address is already registered.' });

    try {
      db.prepare(`INSERT INTO users(roll,name,role,hash,email,department,class_division)
        VALUES(?,?,?,?,?,?,?)`).run(
        identifier, fullName, role, bcrypt.hashSync(password, 10), normalizedEmail,
        normalizedDepartment, role === 'student' ? classDivision : null);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE')
        return res.status(409).json({ error: 'That ID or email address is already registered.' });
      throw error;
    }
    res.status(201).json({ ok: true });
  };
}
app.post('/api/register/teacher', registerUser('teacher'));
app.post('/api/register/student', registerUser('student'));

app.post('/api/login', (req, res) => {
  const { roll, password, deviceId } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE roll=?').get(String(roll || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.hash))
    return res.status(401).json({ error: 'Roll number or password is wrong.' });
  if (u.role === 'student') { // device binding: one account = one phone
    if (!deviceId) return res.status(400).json({ error: 'Device ID missing.' });
    if (!u.device) db.prepare('UPDATE users SET device=? WHERE id=?').run(deviceId, u.id);
    else if (u.device !== deviceId)
      return res.status(403).json({ error: 'This account is linked to another phone. Ask your teacher to unbind it.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { id: u.id, role: u.role });
  res.json({ token, role: u.role, name: u.name });
});

// ---- Teacher ----
app.post('/api/start', auth('teacher'), (req, res) => {
  db.prepare('UPDATE sessions SET open=0 WHERE teacher_id=?').run(req.user.id);
  const mins = Math.min(Math.max(+req.body.minutes || 10, 1), 60);
  db.prepare('INSERT INTO sessions(teacher_id,subject,secret,subnet,started,ends) VALUES(?,?,?,?,?,?)').run(
    req.user.id, String(req.body.subject || 'Class').slice(0, 60), crypto.randomBytes(16).toString('hex'),
    subnet(ipOf(req)), Date.now(), Date.now() + mins * 60000);
  res.json({ ok: true });
});
app.post('/api/end', auth('teacher'), (req, res) => {
  db.prepare('UPDATE sessions SET open=0 WHERE teacher_id=?').run(req.user.id);
  res.json({ ok: true });
});
app.get('/api/live', auth('teacher'), (req, res) => {
  const s = openSessions().find(x => x.teacher_id === req.user.id);
  if (!s) return res.json({ open: false });
  const rows = db.prepare(`SELECT u.id, u.roll, u.name, r.status, r.ip, r.ts, (u.device IS NOT NULL) bound
    FROM users u LEFT JOIN records r ON r.student_id=u.id AND r.session_id=?
    WHERE u.role='student' ORDER BY u.roll`).all(s.id);
  res.json({ open: true, id: s.id, subject: s.subject, code: codeFor(s.secret, win()),
    left: STEP - (Math.floor(Date.now() / 1000) % STEP), endsIn: Math.max(0, Math.round((s.ends - Date.now()) / 1000)), rows });
});
app.put('/api/record', auth('teacher'), (req, res) => { // manual override
  const { sessionId, studentId, status } = req.body;
  if (!['P', 'L', 'A'].includes(status)) return res.status(400).json({ error: 'Bad status.' });
  if (!db.prepare('SELECT 1 FROM sessions WHERE id=? AND teacher_id=?').get(sessionId, req.user.id))
    return res.status(403).json({ error: 'Not your session.' });
  db.prepare(`INSERT INTO records(session_id,student_id,status,ip,device,ts) VALUES(?,?,?,'manual',NULL,?)
    ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status`).run(sessionId, studentId, status, Date.now());
  res.json({ ok: true });
});
app.put('/api/unbind', auth('teacher'), (req, res) => {
  db.prepare("UPDATE users SET device=NULL WHERE id=? AND role='student'").run(req.body.studentId);
  res.json({ ok: true });
});
app.get('/api/report', auth('teacher'), (req, res) => res.json(report('', [])));

// ---- Student ----
app.get('/api/me', auth('student'), (req, res) => res.json(report('AND u.id=?', [req.user.id])));
app.post('/api/mark', auth('student'), (req, res) => {
  const code = String(req.body.code || '').trim(), ip = ipOf(req), w = win();
  // The code itself identifies the session. Current and previous window are accepted.
  const s = openSessions().find(x => [w, w - 1].some(k => codeFor(x.secret, k) === code));
  if (!s) return res.status(400).json({ error: 'That code is wrong or expired. Read the current one from the teacher’s screen.' });
  if (STRICT && subnet(ip) !== s.subnet)
    return res.status(403).json({ error: 'Your phone isn’t on the teacher’s network. Join the hotspot and try again.' });
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (db.prepare('SELECT 1 FROM records WHERE session_id=? AND student_id=?').get(s.id, me.id))
    return res.status(409).json({ error: 'You are already marked for this session.' });
  if (db.prepare('SELECT 1 FROM records WHERE session_id=? AND device=?').get(s.id, me.device))
    return res.status(409).json({ error: 'This phone was already used to mark attendance in this session.' });
  const status = Date.now() - s.started > LATE_MIN * 60000 ? 'L' : 'P';
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(s.id, me.id, status, ip, me.device, Date.now());
  res.json({ status, subject: s.subject, ip });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Attendance server running. STRICT_NETWORK=${STRICT ? 'on' : 'off'}`);
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`  Open on any phone on this network: http://${i.address}:${PORT}`));
});
