// SQLite connection and multi-company schema for Pulse Shift LMS (SaaS)
const path = require("path");
const fs = require("fs");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "pulse-shift-lms.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

/*
 * SQLite driver: uses better-sqlite3 when it installed correctly, otherwise Node's built-in
 * node:sqlite (Node 22.13+), which needs no compiling. Both expose the same small API used here:
 * db.prepare(sql).get/all/run, db.exec, db.transaction(fn).
 */
function openBuiltin(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch (e) {
    console.error(`Pulse Shift LMS needs Node.js 22.13 or newer (you have ${process.version}). Install the LTS version from https://nodejs.org and run npm install again.`);
    process.exit(1);
  }
  const raw = new DatabaseSync(file);
  const clean = v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  const args = a => a.length === 1 && a[0] && typeof a[0] === "object" && !Array.isArray(a[0])
    ? [Object.fromEntries(Object.entries(a[0]).map(([k, v]) => [k, clean(v)]))] : a.map(clean);
  const plain = r => r && Object.assign({}, r);
  let depth = 0;
  return {
    driver: "node:sqlite",
    exec: sql => raw.exec(sql),
    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        get: (...a) => plain(st.get(...args(a))),
        all: (...a) => st.all(...args(a)).map(plain),
        run: (...a) => { const r = st.run(...args(a)); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; },
      };
    },
    transaction(fn) {
      return (...a) => {
        const sp = `sp${depth}`;
        raw.exec(depth ? `SAVEPOINT ${sp}` : "BEGIN"); depth++;
        try { const out = fn(...a); depth--; raw.exec(depth ? `RELEASE ${sp}` : "COMMIT"); return out; }
        catch (e) { depth--; raw.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); throw e; }
      };
    },
  };
}
function open(file) {
  if (process.env.SQLITE_DRIVER !== "builtin") {
    try { const Better = require("better-sqlite3"); const d = new Better(file); d.driver = "better-sqlite3"; return d; }
    catch (e) { /* not installed or not built for this system: fall back */ }
  }
  return openBuiltin(file);
}

const db = open(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// Older single-company databases have no org_id; tell the operator instead of failing later
const old = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leads'").get()
  && !db.prepare("SELECT 1 FROM pragma_table_info('leads') WHERE name='org_id'").get();
if (old) { console.error("This database is from the single-company version. Run `npm run seed -- --reset` to rebuild it."); process.exit(1); }

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,                 -- company code staff use to join
  plan TEXT NOT NULL DEFAULT 'trial',        -- trial | free | pro | business
  status TEXT NOT NULL DEFAULT 'active',     -- active | suspended
  trial_ends_at INTEGER,
  paid_until INTEGER,                        -- null = no expiry (set manually by platform admin)
  rzp_subscription_id TEXT,
  rzp_subscription_status TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                    -- razorpay | manual
  provider_payment_id TEXT UNIQUE,
  provider_subscription_id TEXT,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,         -- paise
  status TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'custom',      -- superadmin | admin | manager | tl | coordinator | telecaller | accounts | custom
  scope TEXT NOT NULL DEFAULT 'own',         -- all | hierarchy | team | routed | own | converted
  perms TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 50,
  system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  demo_password TEXT,
  role_id TEXT REFERENCES roles(id),
  reports_to TEXT REFERENCES staff(id) ON DELETE SET NULL,
  on_time TEXT DEFAULT '09:30',
  off_time TEXT DEFAULT '18:30',
  active INTEGER NOT NULL DEFAULT 1,
  pending INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  platform_admin INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_staff_org ON staff(org_id);

CREATE TABLE IF NOT EXISTS staff_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, by_id TEXT, action TEXT NOT NULL, reason TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, industry TEXT DEFAULT '', sample INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, sample INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product_projects (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, project_id)
);
CREATE TABLE IF NOT EXISTS staff_projects (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, project_id)
);
CREATE TABLE IF NOT EXISTS staff_products (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, product_id)
);

CREATE TABLE IF NOT EXISTS statuses (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cat TEXT NOT NULL DEFAULT 'open', sort INTEGER NOT NULL DEFAULT 50, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS status_products (
  status_id TEXT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (status_id, product_id)
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, industry TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, built_in INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL, mobile TEXT NOT NULL, mobile_digits TEXT NOT NULL,
  email TEXT DEFAULT '', company TEXT DEFAULT '', sample INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(org_id, mobile_digits);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL, mobile TEXT NOT NULL, email TEXT DEFAULT '', company TEXT DEFAULT '',
  product_id TEXT REFERENCES products(id), source_id TEXT REFERENCES sources(id), project_id TEXT REFERENCES projects(id),
  assigned_to TEXT REFERENCES staff(id), status_id TEXT REFERENCES statuses(id),
  follow_up_at TEXT DEFAULT '', customer_id TEXT REFERENCES customers(id),
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, sample INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);

CREATE TABLE IF NOT EXISTS lead_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, by_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_lead ON lead_history(lead_id);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  subject TEXT DEFAULT '', body TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, msg TEXT DEFAULT '', lead_id TEXT, from_id TEXT, at INTEGER NOT NULL,
  sample INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alert_recipients (
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  read_at INTEGER,
  PRIMARY KEY (alert_id, staff_id)
);
`);

module.exports = db;
