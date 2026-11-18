'use strict';
// SQLite database (built into Node 22.13+). For production at scale, swap for PostgreSQL + PostGIS.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'edvitta.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('parent','tutor','admin','staff')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  referral_code TEXT UNIQUE,
  referred_by INTEGER REFERENCES users(id),
  referral_rewarded INTEGER NOT NULL DEFAULT 0,
  wallet_balance INTEGER NOT NULL DEFAULT 0, -- stored in paise (1/100 rupee) to avoid float errors
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  staff_permissions TEXT, -- JSON array for staff accounts
  address TEXT, lat REAL, lng REAL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tutor_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio TEXT DEFAULT '',
  categories TEXT NOT NULL DEFAULT '[]',  -- JSON array of category slugs
  experience_years INTEGER DEFAULT 0,
  qualification TEXT DEFAULT '',
  rate_per_session INTEGER NOT NULL DEFAULT 30000, -- paise
  mode TEXT NOT NULL DEFAULT 'both' CHECK (mode IN ('online','offline','both')),
  gender TEXT DEFAULT '',
  lat REAL, lng REAL, address TEXT,
  available INTEGER NOT NULL DEFAULT 0,
  kyc_status TEXT NOT NULL DEFAULT 'not_submitted'
    CHECK (kyc_status IN ('not_submitted','submitted','approved','rejected')),
  kyc_note TEXT,
  kyc_reviewed_by INTEGER REFERENCES users(id),
  kyc_reviewed_at INTEGER,
  police_verification INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grp TEXT NOT NULL,
  icon TEXT
);

CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  grade TEXT,
  age INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES users(id),
  tutor_id INTEGER NOT NULL REFERENCES users(id),
  child_id INTEGER REFERENCES children(id),
  category TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('online','offline')),
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once','daily','custom')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '[]', -- for custom: [0..6]
  time TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  address TEXT, lat REAL, lng REAL,
  notes TEXT,
  rate INTEGER NOT NULL,
  total_sessions INTEGER NOT NULL,
  gross_amount INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  coupon_code TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','accepted','rejected','cancelled','completed')),
  meeting_link TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','on_the_way','in_progress','completed','cancelled','missed')),
  start_otp TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER,
  payout INTEGER
);

CREATE TABLE IF NOT EXISTS tutor_locations (
  tutor_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS manual_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  utr TEXT NOT NULL UNIQUE,
  proof_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  upi_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('percent','flat')),
  value INTEGER NOT NULL,        -- percent (1-100) or paise
  max_discount INTEGER,          -- paise
  min_amount INTEGER NOT NULL DEFAULT 0,
  usage_limit INTEGER,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL REFERENCES coupons(code),
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  discount INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advertiser_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT,
  image_url TEXT,
  link TEXT,
  placement TEXT NOT NULL DEFAULT 'home' CHECK (placement IN ('home','search','community','dashboard')),
  days INTEGER NOT NULL DEFAULT 7,
  price INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','expired','paused')),
  starts_at INTEGER, ends_at INTEGER,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS community_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  apartment TEXT NOT NULL,
  category TEXT NOT NULL,
  grade TEXT,
  description TEXT,
  fee INTEGER NOT NULL,           -- per child, paise
  max_members INTEGER NOT NULL DEFAULT 10,
  tutor_id INTEGER REFERENCES users(id),
  schedule TEXT,
  lat REAL, lng REAL,
  escrow INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','full','closed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES users(id),
  child_id INTEGER NOT NULL REFERENCES children(id),
  paid INTEGER NOT NULL,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (group_id, child_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to INTEGER REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS reviews (
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),
  parent_id INTEGER NOT NULL, tutor_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  lat REAL, lng REAL, message TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled')),
  handled_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_bookings_parent ON bookings(parent_id);
CREATE INDEX IF NOT EXISTS idx_bookings_tutor ON bookings(tutor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_booking ON sessions(booking_id);
CREATE INDEX IF NOT EXISTS idx_txn_user ON wallet_txns(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
`);

// ---------- Migrations for databases created by earlier versions ----------
function addCol(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addCol('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'lang', "TEXT NOT NULL DEFAULT 'en'");
addCol('users', 'email_notifications', 'INTEGER NOT NULL DEFAULT 1');
addCol('tutor_profiles', 'background_check', "TEXT NOT NULL DEFAULT 'not_started'");
addCol('tutor_profiles', 'background_note', 'TEXT');
addCol('tutor_profiles', 'background_checked_at', 'INTEGER');
addCol('tutor_profiles', 'offers_trial', 'INTEGER NOT NULL DEFAULT 1');
addCol('tutor_profiles', 'trial_fee', 'INTEGER NOT NULL DEFAULT 0');
addCol('tutor_profiles', 'gstin', 'TEXT');
addCol('tutor_profiles', 'pan_number', 'TEXT');
addCol('bookings', 'package_id', 'INTEGER');
addCol('bookings', 'is_trial', 'INTEGER NOT NULL DEFAULT 0');
addCol('sessions', 'commission', 'INTEGER');
addCol('sessions', 'gst', 'INTEGER');
addCol('sessions', 'gross', 'INTEGER');
// Older databases: the one-time-code table gains the 'mfa' purpose (codes are short-lived, so it is safe to recreate).
const otpSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'otps'").get()?.sql;
if (otpSql && !/'mfa'/.test(otpSql)) {
  db.exec(`DROP TABLE otps; CREATE TABLE otps (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('login','verify','reset','mfa')), code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email, purpose);`);
}
// Round 3: attendance, holidays, rescheduling, WhatsApp, payouts.
addCol('sessions', 'attendance', 'TEXT');          // present | tutor_absent | student_absent | not_marked | holiday
addCol('sessions', 'attendance_note', 'TEXT');
addCol('sessions', 'marked_by', 'INTEGER');
addCol('sessions', 'marked_at', 'INTEGER');
addCol('sessions', 'original_date', 'TEXT');       // set when a class is moved to a new date
addCol('sessions', 'makeup_for', 'INTEGER');       // id of the missed session this one replaces
addCol('users', 'whatsapp_alerts', 'INTEGER NOT NULL DEFAULT 1');
addCol('tutor_profiles', 'payout_upi', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('platform','tutor','booking')),
  ref_id INTEGER,                  -- tutor user id or booking id (NULL for platform)
  date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  moved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (scope, ref_id, date)
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date, status);
CREATE INDEX IF NOT EXISTS idx_sessions_booking ON sessions(booking_id);
CREATE TABLE IF NOT EXISTS whatsapp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL, template TEXT, status TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS payout_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,
  tutors INTEGER NOT NULL, gross INTEGER NOT NULL, commission INTEGER NOT NULL, gst INTEGER NOT NULL, net INTEGER NOT NULL,
  withdrawals_created INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS job_runs (name TEXT PRIMARY KEY, last_key TEXT, ran_at INTEGER);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','verify','reset','mfa')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email, purpose);

CREATE TABLE IF NOT EXISTS session_reviews (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  parent_id INTEGER NOT NULL, tutor_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  punctuality INTEGER CHECK (punctuality BETWEEN 1 AND 5),
  teaching INTEGER CHECK (teaching BETWEEN 1 AND 5),
  comment TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id);

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  caller_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('masked_call','video')),
  status TEXT NOT NULL,
  provider_ref TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS progress_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  session_id INTEGER REFERENCES sessions(id),
  tutor_id INTEGER NOT NULL REFERENCES users(id),
  topics TEXT NOT NULL,
  understanding INTEGER CHECK (understanding BETWEEN 1 AND 5),
  strengths TEXT, improve TEXT, notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  tutor_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  details TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','done','reviewed')),
  parent_note TEXT, tutor_feedback TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  validity_days INTEGER NOT NULL DEFAULT 30,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('commission','booking')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  session_id INTEGER REFERENCES sessions(id),
  period TEXT,
  gross INTEGER NOT NULL,          -- class fee / booking value (paise)
  commission_percent REAL NOT NULL,
  commission INTEGER NOT NULL,
  gst_percent REAL NOT NULL DEFAULT 0,
  gst INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL,            -- tutor receives (commission invoice) or parent paid (booking receipt)
  meta TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);

CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  payment_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`);

// A persistent secret for this installation (used when JWT_SECRET / SETTINGS_KEY env vars are not set),
// so logins survive restarts and stored API passwords can be decrypted.
const SECRET_FILE = path.join(DATA_DIR, '.secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, require('crypto').randomBytes(48).toString('hex'), { mode: 0o600 });
const LOCAL_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

// Transaction helper: runs fn atomically.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

// Secrets (SMTP password, gateway keys) are encrypted at rest with AES-256-GCM.
const crypto = require('crypto');
const SETTINGS_KEY = crypto.createHash('sha256').update(process.env.SETTINGS_KEY || LOCAL_SECRET).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SETTINGS_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(val) {
  if (!val || !val.startsWith('enc:')) return val;
  try {
    const b = Buffer.from(val.slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', SETTINGS_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const getSecret = (key) => decrypt(getSetting(key, '')) || '';
const setSecret = (key, value) => setSetting(key, value ? encrypt(value) : '');

function getSetting(key, def) {
  const r = q.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

const flag = (key, def = '0') => getSetting(key, def) === '1';

module.exports = { db, q, tx, getSetting, setSetting, getSecret, setSecret, flag, DATA_DIR, LOCAL_SECRET };
