// Pulse Shift LMS (SaaS) — Express API + static frontend
require("./env");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { PLANS, PAID, effectivePlan } = require("./plans");
const { createOrg, PERMS } = require("./tenant");

const PORT = Number(process.env.PORT || 3000);
const COOKIE = "psm_session";
const SHOW_DEMO = (process.env.SHOW_DEMO_LOGINS || "true") !== "false";
const DATA_DIR = path.dirname(process.env.DB_FILE || path.join(__dirname, "..", "data", "x"));
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const f = path.join(DATA_DIR, ".jwt-secret");
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(f, "utf8").trim();
})();
const RZP = { key: process.env.RAZORPAY_KEY_ID || "", secret: process.env.RAZORPAY_KEY_SECRET || "", webhook: process.env.RAZORPAY_WEBHOOK_SECRET || "" };
const billingOn = () => !!(RZP.key && RZP.secret);
const PLATFORM_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);

const SCOPES = ["all","hierarchy","team","routed","own","converted"];
const CATS = ["new","open","followup","converted","dead"];
const CHANNELS = ["email","sms","whatsapp"];

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); res.set("X-Frame-Options", "SAMEORIGIN"); res.set("Referrer-Policy", "same-origin"); next(); });

/* ------------------------------------------------------------------ helpers */
const uid = () => crypto.randomUUID();
const now = () => Date.now();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const arr = v => Array.isArray(v) ? [...new Set(v.map(x => String(x)))] : [];
const digits = s => String(s || "").replace(/\D/g, "");
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const pwOk = p => typeof p === "string" && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);
const PW_RULE = "Use at least 8 characters, including a letter and a number.";
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const wrap = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

const getOrg = id => db.prepare("SELECT * FROM orgs WHERE id=?").get(id);
const getRole = id => { const r = db.prepare("SELECT * FROM roles WHERE id=?").get(id); if (r) r.perms = JSON.parse(r.perms || "{}"); return r; };
const getStaff = id => db.prepare("SELECT * FROM staff WHERE id=?").get(id);
const orgStaff = org => db.prepare("SELECT * FROM staff WHERE org_id=?").all(org);
const inOrg = (table, id, org) => !!(id && db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND org_id=?`).get(id, org));
const isSuper = me => me.role?.level === "superadmin";
const can = (me, p) => isSuper(me) || !!me.role?.perms?.[p];
const need = (me, p) => { if (!can(me, p)) fail(403, "Your role doesn't allow this."); };
const needSuper = me => { if (!isSuper(me)) fail(403, "Only Super Admin can do this."); };
const scopeOf = me => isSuper(me) ? "all" : (me.role?.scope || "own");
const usable = s => s && s.active && !s.pending && !s.rejected;

function descendants(id, staff) {
  const out = [], q = [id];
  while (q.length) { const c = q.shift(); for (const s of staff) if (s.reports_to === c && s.id !== id && !out.includes(s.id)) { out.push(s.id); q.push(s.id); } }
  return out;
}
function reach(me) {
  const staff = orgStaff(me.org_id).filter(s => !s.pending && !s.rejected);
  return scopeOf(me) === "all" ? staff.map(s => s.id) : [me.id, ...descendants(me.id, staff)];
}
const catMap = org => Object.fromEntries(db.prepare("SELECT id,cat FROM statuses WHERE org_id=?").all(org).map(s => [s.id, s.cat]));
const statusCat = id => db.prepare("SELECT cat FROM statuses WHERE id=?").get(id)?.cat || "new";
const closedCat = c => c === "converted" || c === "dead";
function visibleLeads(me) {
  const rows = db.prepare("SELECT * FROM leads WHERE org_id=?").all(me.org_id);
  const sc = scopeOf(me); if (sc === "all") return rows;
  const staff = orgStaff(me.org_id), cats = catMap(me.org_id);
  const set = sc === "hierarchy" ? new Set([me.id, ...descendants(me.id, staff)]) : sc === "team" ? new Set([me.id, ...staff.filter(s => s.reports_to === me.id).map(s => s.id)]) : new Set([me.id]);
  return rows.filter(l => sc === "routed" ? (l.assigned_to === me.id || l.created_by === me.id) : sc === "converted" ? (l.assigned_to === me.id || cats[l.status_id] === "converted") : set.has(l.assigned_to));
}
function loadLead(me, id) {
  const l = db.prepare("SELECT * FROM leads WHERE id=? AND org_id=?").get(id, me.org_id);
  if (!l || !visibleLeads(me).some(x => x.id === l.id)) fail(404, "Lead not found.");
  return l;
}
function statusesFor(org, pid) {
  return db.prepare(`SELECT s.* FROM statuses s WHERE s.org_id=? AND s.active=1 AND (NOT EXISTS (SELECT 1 FROM status_products sp WHERE sp.status_id=s.id) OR EXISTS (SELECT 1 FROM status_products sp WHERE sp.status_id=s.id AND sp.product_id=?)) ORDER BY s.sort`).all(org, pid);
}
const defaultStatus = (org, pid) => { const l = statusesFor(org, pid); return (l.find(s => s.cat === "new") || l[0])?.id || null; };
function onShift(s) {
  if (!s.on_time || !s.off_time) return true;
  const d = new Date(), cur = d.getHours() * 60 + d.getMinutes(), t = v => { const [a, b] = v.split(":").map(Number); return a * 60 + b; };
  const on = t(s.on_time), off = t(s.off_time); return on <= off ? cur >= on && cur < off : cur >= on || cur < off;
}
function autoAssign(org, pid) {
  const cats = catMap(org);
  const pool = orgStaff(org).filter(s => usable(s) && ["telecaller", "coordinator"].includes(getRole(s.role_id)?.level)).filter(s => {
    const prods = db.prepare("SELECT product_id FROM staff_products WHERE staff_id=?").all(s.id).map(r => r.product_id);
    return !prods.length || prods.includes(pid);
  });
  const open = id => db.prepare("SELECT status_id FROM leads WHERE assigned_to=?").all(id).filter(l => !closedCat(cats[l.status_id])).length;
  const shift = pool.filter(onShift), use = shift.length ? shift : pool;
  use.sort((a, b) => open(a.id) - open(b.id)); return use[0]?.id || null;
}
function nextCode(table, prefix, start, org) {
  const n = db.prepare(`SELECT MAX(CAST(SUBSTR(code, ${prefix.length + 2}) AS INTEGER)) m FROM ${table} WHERE org_id=? AND code GLOB '${prefix}-[0-9]*'`).get(org).m;
  return `${prefix}-${Math.max(start, (n || 0) + 1)}`;
}
const addHistory = (leadId, by, kind, text) => db.prepare("INSERT INTO lead_history (lead_id,at,by_id,kind,text) VALUES (?,?,?,?,?)").run(leadId, now(), by, kind, str(text, 2000));
const addStaffLog = (sid, by, action, reason = "") => db.prepare("INSERT INTO staff_log (staff_id,at,by_id,action,reason) VALUES (?,?,?,?,?)").run(sid, now(), by, action, str(reason, 500));
const nameOf = (table, id) => id ? db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(id)?.name || "" : "";
function sendAlert({ org, type, title, msg = "", leadId = null, from = null, to }) {
  const ids = [...new Set(to.filter(Boolean))]; if (!ids.length) return;
  const id = uid();
  db.prepare("INSERT INTO alerts (id,org_id,type,title,msg,lead_id,from_id,at) VALUES (?,?,?,?,?,?,?,?)").run(id, org, type, str(title, 200), str(msg, 1000), leadId, from, now());
  const ins = db.prepare("INSERT OR IGNORE INTO alert_recipients (alert_id,staff_id) VALUES (?,?)"); ids.forEach(s => ins.run(id, s));
}
const newLeadAlert = (org, lead, to, by, title = "New lead assigned") => {
  const s = getStaff(to); sendAlert({ org, type: "newlead", title, msg: `${lead.name} · ${nameOf("products", lead.product_id)}`, leadId: lead.id, from: by, to: [to, s?.reports_to] });
};
const orgAdmins = org => orgStaff(org).filter(s => { const r = usable(s) && getRole(s.role_id); return r && (r.level === "superadmin" || r.perms.manageStaff); }).map(s => s.id);

/* ---- plan limits */
const monthStart = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };
function usage(org) {
  return {
    users: db.prepare("SELECT COUNT(*) n FROM staff WHERE org_id=? AND active=1 AND pending=0 AND rejected=0 AND demo_password IS NULL").get(org).n,
    leadsThisMonth: db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=? AND created_at>=? AND sample=0").get(org, monthStart()).n,
  };
}
function checkLimit(org, kind, adding = 1) {
  const plan = effectivePlan(getOrg(org)), u = usage(org);
  if (kind === "users" && u.users + adding > plan.users) fail(402, `Your ${plan.name} plan allows ${plan.users} active users. Upgrade in Company & Billing to add more.`);
  if (kind === "leads" && u.leadsThisMonth + adding > plan.leadsPerMonth) fail(402, `Your ${plan.name} plan allows ${plan.leadsPerMonth.toLocaleString("en-GB")} new leads a month. Upgrade in Company & Billing to add more.`);
}

/* ------------------------------------------------------------------ live updates (SSE, per company) */
const clients = new Map(); // res -> orgId
function broadcast(org) { for (const [res, o] of clients) if (o === org) { try { res.write("event: change\ndata: {}\n\n"); } catch (e) { clients.delete(res); } } }
setInterval(() => { for (const res of clients.keys()) { try { res.write(": ping\n\n"); } catch (e) { clients.delete(res); } } }, 25000).unref();

/* ------------------------------------------------------------------ Razorpay */
async function rzp(method, url, body) {
  const r = await fetch("https://api.razorpay.com/v1" + url, { method, headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${RZP.key}:${RZP.secret}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) fail(502, `Razorpay: ${d.error?.description || "request failed"}`);
  return d;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function activatePaid(org, plan, { paymentId, subId, amount = 0, provider = "razorpay" }) {
  db.transaction(() => {
    const o = getOrg(org); const from = Math.max(now(), o?.paid_until || 0);
    db.prepare("UPDATE orgs SET plan=?, paid_until=?, rzp_subscription_status='active' WHERE id=?").run(plan, from + 31 * 24 * 3600e3, org);
    if (paymentId) db.prepare("INSERT OR IGNORE INTO payments (id,org_id,provider,provider_payment_id,provider_subscription_id,plan,amount,status,at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(uid(), org, provider, paymentId, subId || null, plan, amount, "captured", now());
  })();
  broadcast(org);
}

// Webhook needs the raw body for signature checks, so it is registered before express.json()
app.post("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  if (!RZP.webhook) return res.status(503).json({ error: "Webhook secret not configured." });
  const sig = req.get("x-razorpay-signature") || "";
  const expect = crypto.createHmac("sha256", RZP.webhook).update(req.body).digest("hex");
  if (!safeEq(sig, expect)) return res.status(400).json({ error: "Bad signature." });
  let ev; try { ev = JSON.parse(req.body.toString("utf8")); } catch (e) { return res.status(400).end(); }
  const sub = ev.payload?.subscription?.entity, pay = ev.payload?.payment?.entity;
  const org = sub?.notes?.org_id || db.prepare("SELECT id FROM orgs WHERE rzp_subscription_id=?").get(sub?.id)?.id;
  if (!org || !getOrg(org)) return res.json({ ok: true });
  const plan = Object.values(PLANS).find(p => p.rzpEnv && process.env[p.rzpEnv] === sub?.plan_id)?.id || sub?.notes?.plan;
  if (["subscription.activated", "subscription.charged"].includes(ev.event) && PAID.includes(plan)) activatePaid(org, plan, { paymentId: pay?.id, subId: sub?.id, amount: pay?.amount || 0 });
  else if (["subscription.halted", "subscription.cancelled", "subscription.completed", "subscription.paused"].includes(ev.event)) { db.prepare("UPDATE orgs SET rzp_subscription_status=? WHERE id=?").run(ev.event.split(".")[1], org); broadcast(org); }
  res.json({ ok: true });
});

app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());

/* ------------------------------------------------------------------ auth */
function issue(res, staffId, remember) {
  const token = jwt.sign({ sid: staffId }, JWT_SECRET, { expiresIn: remember ? "30d" : "12h" });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true", ...(remember ? { maxAge: 30 * 24 * 3600e3 } : {}) });
}
function auth(req, res, next) {
  try {
    const tok = req.cookies[COOKIE]; if (!tok) fail(401, "Please log in.");
    let p; try { p = jwt.verify(tok, JWT_SECRET); } catch (e) { fail(401, "Your session has expired. Please log in again."); }
    const s = getStaff(p.sid); if (!usable(s)) { res.clearCookie(COOKIE); fail(401, "Your account is no longer active."); }
    const org = getOrg(s.org_id);
    if (org?.status !== "active" && !s.platform_admin) { res.clearCookie(COOKIE); fail(401, "Your company account is suspended. Contact Pulse Shift Media support."); }
    if (PLATFORM_EMAILS.includes(s.email.toLowerCase())) s.platform_admin = 1;
    s.role = getRole(s.role_id); s.org = org; req.me = s; next();
  } catch (e) { next(e); }
}
const attempts = new Map();
function throttle(key) {
  const a = attempts.get(key) || { n: 0, t: 0 };
  if (a.n >= 5 && now() - a.t < 60000) fail(429, `Too many attempts. Try again in ${Math.ceil((60000 - (now() - a.t)) / 1000)} seconds.`);
  if (now() - a.t >= 60000) a.n = 0;
  return a;
}

app.get("/api/auth/demo-accounts", (req, res) => {
  if (!SHOW_DEMO) return res.json([]);
  const order = ["superadmin", "admin", "manager", "tl", "coordinator", "telecaller", "accounts", "custom"];
  const rows = db.prepare(`SELECT s.email, s.demo_password pw, r.level, r.name role, o.status FROM staff s JOIN roles r ON r.id=s.role_id JOIN orgs o ON o.id=s.org_id
    WHERE s.demo_password IS NOT NULL AND s.active=1 AND s.pending=0 AND s.rejected=0 AND o.status='active'`).all()
    .sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || a.email.localeCompare(b.email));
  const seen = new Set();
  res.json(rows.filter(r => !seen.has(r.level) && seen.add(r.level)).map(r => ({ role: r.role, email: r.email, password: r.pw })));
});

app.post("/api/auth/login", wrap((req, res) => {
  const email = str(req.body.email, 200).toLowerCase(), pw = String(req.body.password || "");
  if (!emailOk(email) || !pw) fail(400, "Enter your email and password.");
  const key = req.ip + "|" + email; const a = throttle(key);
  const s = db.prepare("SELECT * FROM staff WHERE email=?").get(email);
  const bad = () => { a.n++; a.t = now(); attempts.set(key, a); fail(401, a.n >= 5 ? "Wrong email or password. Wait a minute before trying again." : "Wrong email or password."); };
  if (s && !s.password_hash && !s.rejected) fail(400, "Your Admin added this email but no password is set yet. Choose Sign up → Join my team to create one.");
  if (!s || !bcrypt.compareSync(pw, s.password_hash)) bad();
  attempts.delete(key);
  if (s.rejected) fail(403, "This sign-up was declined. Contact your Admin.");
  if (s.pending) fail(403, "Your account is waiting for Admin approval. You'll be able to log in once your role is assigned.");
  if (!s.active) fail(403, "Your account is deactivated. Contact your Admin.");
  if (getOrg(s.org_id)?.status !== "active" && !s.platform_admin) fail(403, "Your company account is suspended. Contact Pulse Shift Media support.");
  db.prepare("UPDATE staff SET last_login_at=? WHERE id=?").run(now(), s.id);
  issue(res, s.id, !!req.body.remember);
  res.json({ ok: true, name: s.name });
}));

// mode "company": create a new company workspace (14-day trial). mode "join": join an existing company with its code.
app.post("/api/auth/signup", wrap((req, res) => {
  const mode = req.body.mode === "join" ? "join" : "company";
  const name = str(req.body.name, 100), mobile = str(req.body.mobile, 20), email = str(req.body.email, 200).toLowerCase(), pw = String(req.body.password || "");
  if (name.length < 2) fail(400, "Enter your full name.");
  if (digits(mobile).length < 9) fail(400, "Enter a valid mobile number, e.g. 050 123 4567 or +971 50 123 4567.");
  if (!emailOk(email)) fail(400, "Enter a valid email address.");
  if (!pwOk(pw)) fail(400, PW_RULE);
  throttle(req.ip + "|signup");
  const ex = db.prepare("SELECT * FROM staff WHERE email=?").get(email);
  const hash = bcrypt.hashSync(pw, 10);

  if (mode === "company") {
    const company = str(req.body.company, 100); if (company.length < 2) fail(400, "Enter your company name.");
    if (ex) fail(400, "That email is already registered. Log in instead.");
    const id = uid();
    const org = db.transaction(() => {
      const o = createOrg(company);
      db.prepare(`INSERT INTO staff (id,org_id,name,mobile,email,password_hash,role_id,active,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,1,?,?)`).run(id, o.orgId, name, mobile, email, hash, o.roles.superadmin, now(), now());
      addStaffLog(id, null, "Created company and Super Admin account");
      return o;
    })();
    issue(res, id, true); return res.json({ status: "active", name, company, code: org.code });
  }

  const code = str(req.body.code, 20).toUpperCase();
  if (ex) {
    if (ex.rejected) fail(400, "A sign-up with this email was declined. Contact your Admin.");
    if (ex.demo_password) fail(400, "That's a demo login. Go to Log in and tap its card.");
    if (ex.password_hash) fail(400, "That email is already registered. Log in instead.");
    if (["superadmin", "admin"].includes(getRole(ex.role_id)?.level)) fail(403, "This email belongs to an admin account. Ask your Super Admin to set its password from Staff.");
    db.prepare("UPDATE staff SET password_hash=?, mobile=COALESCE(NULLIF(mobile,''),?) WHERE id=?").run(hash, mobile, ex.id);
    addStaffLog(ex.id, ex.id, "Signed up and set password"); broadcast(ex.org_id);
    if (!ex.active) return res.json({ status: "inactive" });
    db.prepare("UPDATE staff SET last_login_at=? WHERE id=?").run(now(), ex.id);
    issue(res, ex.id, true); return res.json({ status: "active", name: ex.name });
  }
  const org = db.prepare("SELECT * FROM orgs WHERE code=?").get(code);
  if (!org) fail(400, "No company uses that code. Ask your Admin for the company code shown in Company & Billing.");
  if (org.status !== "active") fail(403, "That company account is suspended.");
  const id = uid();
  db.prepare(`INSERT INTO staff (id,org_id,name,mobile,email,password_hash,active,pending,created_at) VALUES (?,?,?,?,?,?,0,1,?)`).run(id, org.id, name, mobile, email, hash, now());
  addStaffLog(id, null, "Signed up, awaiting approval");
  sendAlert({ org: org.id, type: "admin", title: "New sign-up waiting for approval", msg: `${name} · ${email}`, to: orgAdmins(org.id) });
  broadcast(org.id); res.json({ status: "pending", company: org.name });
}));

app.post("/api/auth/logout", (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
app.get("/api/auth/me", auth, (req, res) => res.json({ id: req.me.id, name: req.me.name }));
app.post("/api/auth/password", auth, wrap((req, res) => {
  const s = req.me;
  if (!bcrypt.compareSync(String(req.body.current || ""), s.password_hash || "")) fail(400, "Your current password is wrong.");
  if (!pwOk(req.body.next)) fail(400, PW_RULE);
  db.prepare("UPDATE staff SET password_hash=?, demo_password=NULL WHERE id=?").run(bcrypt.hashSync(req.body.next, 10), s.id);
  addStaffLog(s.id, s.id, "Changed password"); res.json({ ok: true });
}));

/* ------------------------------------------------------------------ everything below needs a session */
app.use("/api", auth);

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders(); res.write("retry: 5000\n\n"); clients.set(res, req.me.org_id); req.on("close", () => clients.delete(res));
});

function orgInfo(me) {
  const o = me.org, plan = effectivePlan(o);
  return { id: o.id, name: o.name, code: o.code, plan: o.plan, status: o.status, trialEndsAt: o.trial_ends_at, paidUntil: o.paid_until,
    subscriptionStatus: o.rzp_subscription_status, effective: plan, usage: usage(o.id), billingEnabled: billingOn(),
    plans: Object.values(PLANS).filter(p => p.id !== "trial").map(p => ({ id: p.id, name: p.name, price: p.price, users: p.users, leadsPerMonth: p.leadsPerMonth, available: p.price === 0 || !!process.env[p.rzpEnv] })),
    payments: isSuper(me) ? db.prepare("SELECT * FROM payments WHERE org_id=? ORDER BY at DESC LIMIT 24").all(o.id).map(p => ({ id: p.id, provider: p.provider, plan: p.plan, amount: p.amount, status: p.status, at: p.at, ref: p.provider_payment_id })) : [] };
}

app.get("/api/bootstrap", wrap((req, res) => {
  let me = req.me; const O = me.org_id;
  if (req.query.as && isSuper(req.me) && req.query.as !== req.me.id) { const p = getStaff(String(req.query.as)); if (p && p.org_id === O && !p.pending && !p.rejected) { p.role = getRole(p.role_id); p.org = me.org; me = p; } }
  const join = sql => { const m = {}; for (const r of db.prepare(sql).all(O)) (m[r.k] ||= []).push(r.v); return m; };
  const sProj = join("SELECT sp.staff_id k, sp.project_id v FROM staff_projects sp JOIN staff s ON s.id=sp.staff_id WHERE s.org_id=?");
  const sProd = join("SELECT sp.staff_id k, sp.product_id v FROM staff_products sp JOIN staff s ON s.id=sp.staff_id WHERE s.org_id=?");
  const stProd = join("SELECT sp.status_id k, sp.product_id v FROM status_products sp JOIN statuses s ON s.id=sp.status_id WHERE s.org_id=?");
  const pProj = join("SELECT pp.product_id k, pp.project_id v FROM product_projects pp JOIN products p ON p.id=pp.product_id WHERE p.org_id=?");
  const manage = can(req.me, "manageStaff");
  const logs = manage ? join("SELECT l.staff_id k, json_object('at',l.at,'by',l.by_id,'action',l.action,'reason',l.reason) v FROM staff_log l JOIN staff s ON s.id=l.staff_id WHERE s.org_id=? ORDER BY l.at DESC") : {};
  const leads = visibleLeads(me);
  const hist = {}; if (leads.length) for (const h of db.prepare(`SELECT * FROM lead_history WHERE lead_id IN (${leads.map(() => "?").join(",")}) ORDER BY at DESC, id DESC`).all(...leads.map(l => l.id))) (hist[h.lead_id] ||= []).push({ at: h.at, by: h.by_id, kind: h.kind, text: h.text });
  const custIds = new Set(leads.map(l => l.customer_id));
  const customers = db.prepare("SELECT * FROM customers WHERE org_id=?").all(O).filter(c => scopeOf(me) === "all" || custIds.has(c.id));
  const alerts = db.prepare(`SELECT a.* FROM alerts a WHERE a.org_id=? AND (a.from_id=? OR EXISTS (SELECT 1 FROM alert_recipients r WHERE r.alert_id=a.id AND r.staff_id=?)) ORDER BY a.at DESC LIMIT 300`).all(O, me.id, me.id);
  const recips = {}; if (alerts.length) for (const r of db.prepare(`SELECT * FROM alert_recipients WHERE alert_id IN (${alerts.map(() => "?").join(",")})`).all(...alerts.map(a => a.id))) (recips[r.alert_id] ||= []).push(r);

  res.json({
    me: me.id, realMe: req.me.id, platformAdmin: !!req.me.platform_admin, org: orgInfo(req.me),
    roles: db.prepare("SELECT * FROM roles WHERE org_id=? ORDER BY sort").all(O).map(r => ({ id: r.id, name: r.name, level: r.level, scope: r.scope, perms: JSON.parse(r.perms || "{}"), order: r.sort, system: !!r.system })),
    staff: orgStaff(O).map(s => ({ id: s.id, name: s.name, mobile: s.mobile, email: s.email, roleId: s.role_id || "", reportsTo: s.reports_to || "", onTime: s.on_time, offTime: s.off_time,
      active: !!s.active, pending: !!s.pending, rejected: !!s.rejected, sample: !!s.sample, createdAt: s.created_at, lastLoginAt: s.last_login_at, hasLogin: !!s.password_hash, isDemo: !!s.demo_password,
      projects: sProj[s.id] || [], products: sProd[s.id] || [], ...(manage ? { log: (logs[s.id] || []).map(x => JSON.parse(x)) } : {}) })),
    statuses: db.prepare("SELECT * FROM statuses WHERE org_id=? ORDER BY sort").all(O).map(s => ({ id: s.id, name: s.name, cat: s.cat, order: s.sort, active: !!s.active, products: stProd[s.id] || [] })),
    sources: db.prepare("SELECT * FROM sources WHERE org_id=?").all(O).map(s => ({ id: s.id, name: s.name, industry: s.industry, active: !!s.active, builtIn: !!s.built_in })),
    projects: db.prepare("SELECT * FROM projects WHERE org_id=?").all(O).map(p => ({ id: p.id, name: p.name, industry: p.industry, sample: !!p.sample, createdAt: p.created_at })),
    products: db.prepare("SELECT * FROM products WHERE org_id=?").all(O).map(p => ({ id: p.id, name: p.name, description: p.description, active: !!p.active, sample: !!p.sample, projectIds: pProj[p.id] || [] })),
    customers: customers.map(c => ({ id: c.id, code: c.code, name: c.name, mobile: c.mobile, email: c.email, company: c.company, sample: !!c.sample, createdAt: c.created_at })),
    leads: leads.map(l => ({ id: l.id, code: l.code, name: l.name, mobile: l.mobile, email: l.email, company: l.company, productId: l.product_id || "", sourceId: l.source_id || "", projectId: l.project_id || "",
      assignedTo: l.assigned_to || "", statusId: l.status_id || "", followUpAt: l.follow_up_at || "", customerId: l.customer_id, createdBy: l.created_by || "", createdAt: l.created_at, updatedAt: l.updated_at, sample: !!l.sample, history: hist[l.id] || [] })),
    templates: db.prepare("SELECT * FROM templates WHERE org_id=? ORDER BY created_at").all(O).map(t => ({ id: t.id, name: t.name, channel: t.channel, type: t.type, productId: t.product_id || "", subject: t.subject, body: t.body, sample: !!t.sample })),
    alerts: alerts.map(a => ({ id: a.id, type: a.type, title: a.title, msg: a.msg, leadId: a.lead_id, from: a.from_id || "", at: a.at, sample: !!a.sample, to: (recips[a.id] || []).map(r => r.staff_id), readBy: (recips[a.id] || []).filter(r => r.read_at).map(r => r.staff_id) })),
  });
}));

/* ------------------------------------------------------------------ leads */
app.post("/api/leads", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "createLead"); const b = req.body;
  const name = str(b.name, 120), mobile = str(b.mobile, 20);
  if (!name || digits(mobile).length < 6) fail(400, "Name and a valid mobile number are required.");
  const pid = str(b.productId, 64); if (!inOrg("products", pid, O)) fail(400, "Choose a product.");
  const src = str(b.sourceId, 64); if (!inOrg("sources", src, O)) fail(400, "Choose a source.");
  checkLimit(O, "leads");
  let proj = str(b.projectId, 64) || db.prepare("SELECT project_id FROM product_projects WHERE product_id=?").get(pid)?.project_id || null;
  if (proj && !inOrg("projects", proj, O)) proj = null;
  let ass = me.id;
  if (can(me, "assignLead")) {
    ass = b.assignedTo === "_auto" ? autoAssign(O, pid) : (str(b.assignedTo, 64) || null);
    if (ass && b.assignedTo !== "_auto" && (!reach(me).includes(ass) || !usable(getStaff(ass)))) fail(400, "You can't assign leads to that person.");
  }
  let st = str(b.statusId, 64); if (!can(me, "assignStatus") || !statusesFor(O, pid).some(s => s.id === st)) st = defaultStatus(O, pid);
  const fu = DT.test(b.followUpAt || "") ? b.followUpAt : "";
  const lead = db.transaction(() => {
    let c = db.prepare("SELECT * FROM customers WHERE org_id=? AND mobile_digits=?").get(O, digits(mobile));
    if (!c) { c = { id: uid(), code: nextCode("customers", "CUS", 1001, O) }; db.prepare("INSERT INTO customers (id,org_id,code,name,mobile,mobile_digits,email,company,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(c.id, O, c.code, name, mobile, digits(mobile), str(b.email, 200), str(b.company, 120), now()); }
    const l = { id: uid(), org_id: O, code: nextCode("leads", "LD", 2001, O), name, mobile, email: str(b.email, 200), company: str(b.company, 120), product_id: pid, source_id: src, project_id: proj, assigned_to: ass, status_id: st, follow_up_at: fu, customer_id: c.id, created_by: me.id, created_at: now() };
    db.prepare(`INSERT INTO leads (id,org_id,code,name,mobile,email,company,product_id,source_id,project_id,assigned_to,status_id,follow_up_at,customer_id,created_by,created_at)
      VALUES (@id,@org_id,@code,@name,@mobile,@email,@company,@product_id,@source_id,@project_id,@assigned_to,@status_id,@follow_up_at,@customer_id,@created_by,@created_at)`).run(l);
    addHistory(l.id, me.id, "create", `Lead created from ${nameOf("sources", src)}${ass ? ` and assigned to ${nameOf("staff", ass)}` : ""}`);
    if (str(b.remark, 2000)) addHistory(l.id, me.id, "remark", b.remark);
    if (ass) newLeadAlert(O, l, ass, me.id);
    return l;
  })();
  broadcast(O); res.json({ id: lead.id, code: lead.code, assignedTo: lead.assigned_to, assignedName: nameOf("staff", lead.assigned_to) });
}));

/* ---- bulk upload of a lead sheet (CSV / Excel parsed in the browser, sent as rows) */
const norm = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function parseFollowUp(v) {
  const t = String(v ?? "").trim(); if (!t) return "";
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) { const d = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i); if (d) { let h = +(d[4] || 10); if (d[6] && /pm/i.test(d[6]) && h < 12) h += 12; if (d[6] && /am/i.test(d[6]) && h === 12) h = 0; m = [0, d[3], d[2], d[1], h, d[5] || "00"]; } }
  if (!m) return null;
  const p = n => String(n).padStart(2, "0"); const [y, mo, da, h = 10, mi = "00"] = [m[1], m[2], m[3], m[4] ?? 10, m[5] ?? "00"];
  if (+mo < 1 || +mo > 12 || +da < 1 || +da > 31 || +h > 23 || +mi > 59) return null;
  return `${y}-${p(mo)}-${p(da)}T${p(h)}:${p(mi)}`;
}
app.post("/api/leads/import", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "uploadLeads");
  const rows = Array.isArray(req.body.rows) ? req.body.rows : []; const d = req.body.defaults || {};
  if (!rows.length) fail(400, "The sheet has no rows to import.");
  if (rows.length > 2000) fail(400, "Upload up to 2,000 rows at a time. Split the sheet and upload again.");
  const dryRun = !!req.body.dryRun, skipDup = req.body.duplicates !== "add", file = str(req.body.fileName, 120) || "lead sheet";
  const byName = (table, extra = "") => { const m = new Map(); for (const r of db.prepare(`SELECT id,name FROM ${table} WHERE org_id=? ${extra}`).all(O)) m.set(norm(r.name), r.id); return m; };
  const products = byName("products", "AND active=1"), sources = byName("sources", "AND active=1"), projects = byName("projects");
  const canAssign = can(me, "assignLead"), team = new Set(reach(me));
  const staffBy = new Map(); for (const s of orgStaff(O).filter(s => usable(s) && team.has(s.id))) { staffBy.set(norm(s.email), s.id); staffBy.set(norm(s.name), s.id); }
  const defProduct = inOrg("products", d.productId, O) ? d.productId : null, defSource = inOrg("sources", d.sourceId, O) ? d.sourceId : null, defProject = inOrg("projects", d.projectId, O) ? d.projectId : null;
  const assignMode = !canAssign ? "me" : ["me", "auto", "none"].includes(d.assign) ? d.assign : (team.has(d.assign) && usable(getStaff(d.assign)) ? d.assign : "me");
  const existing = new Set(db.prepare("SELECT l.mobile, l.product_id, s.cat FROM leads l LEFT JOIN statuses s ON s.id=l.status_id WHERE l.org_id=?").all(O)
    .filter(l => !closedCat(l.cat)).map(l => digits(l.mobile) + "|" + l.product_id));
  const seen = new Set(), ok = [], errors = [], skipped = [];
  rows.forEach((r, i) => {
    const n = i + 2, why = [];
    const name = str(r.name, 120), mobile = str(r.mobile, 20);
    if (!name) why.push("Name is empty");
    if (digits(mobile).length < 6) why.push("Mobile is missing or too short");
    const look = (val, map, label, def) => { if (!str(val)) return def; const id = map.get(norm(val)); if (!id) why.push(`${label} "${str(val, 60)}" doesn't exist`); return id || null; };
    const pid = look(r.product, products, "Product", defProduct); if (!pid && !str(r.product)) why.push("No product (add a Product column or pick a default)");
    const src = look(r.source, sources, "Source", defSource); if (!src && !str(r.source)) why.push("No source (add a Source column or pick a default)");
    let proj = look(r.project, projects, "Department / project", defProject);
    if (!proj && pid) proj = db.prepare("SELECT project_id FROM product_projects WHERE product_id=?").get(pid)?.project_id || null;
    let ass = assignMode === "me" ? me.id : assignMode === "none" ? null : assignMode === "auto" ? "_auto" : assignMode;
    if (canAssign && str(r.assignedTo)) { const id = staffBy.get(norm(r.assignedTo)); if (id) ass = id; else why.push(`Assigned to "${str(r.assignedTo, 60)}" isn't in your team`); }
    let st = null;
    if (pid) { const list = statusesFor(O, pid); st = (list.find(s => s.cat === "new") || list[0])?.id || null;
      if (str(r.status) && can(me, "assignStatus")) { const f = list.find(s => norm(s.name) === norm(r.status)); if (f) st = f.id; else why.push(`Status "${str(r.status, 40)}" doesn't apply to this product`); } }
    const fu = parseFollowUp(r.followUp); if (fu === null) why.push(`Follow-up date "${str(r.followUp, 30)}" isn't readable (use 2026-11-05 14:30 or 05/11/2026)`);
    if (why.length) return errors.push({ row: n, name, reason: why.join("; ") });
    const key = digits(mobile) + "|" + pid;
    if (skipDup && (existing.has(key) || seen.has(key))) return skipped.push({ row: n, name, reason: seen.has(key) ? "Repeated in this sheet" : "Already an open lead for this product" });
    seen.add(key);
    ok.push({ n, name, mobile, email: str(r.email, 200), company: str(r.company, 120), pid, src, proj, ass, st, fu: fu || "", remark: str(r.remark, 2000) });
  });
  if (dryRun) return res.json({ valid: ok.length, errors, skipped, total: rows.length });
  if (!ok.length) return res.json({ created: 0, errors, skipped, total: rows.length });
  checkLimit(O, "leads", ok.length);
  const perAssignee = new Map();
  db.transaction(() => {
    const findC = db.prepare("SELECT id FROM customers WHERE org_id=? AND mobile_digits=?");
    const insC = db.prepare("INSERT INTO customers (id,org_id,code,name,mobile,mobile_digits,email,company,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    const insL = db.prepare(`INSERT INTO leads (id,org_id,code,name,mobile,email,company,product_id,source_id,project_id,assigned_to,status_id,follow_up_at,customer_id,created_by,created_at)
      VALUES (@id,@org_id,@code,@name,@mobile,@email,@company,@product_id,@source_id,@project_id,@assigned_to,@status_id,@follow_up_at,@customer_id,@created_by,@created_at)`);
    let leadNo = +nextCode("leads", "LD", 2001, O).slice(3), custNo = +nextCode("customers", "CUS", 1001, O).slice(4);
    for (const r of ok) {
      const ass = r.ass === "_auto" ? autoAssign(O, r.pid) : r.ass;
      let cid = findC.get(O, digits(r.mobile))?.id;
      if (!cid) { cid = uid(); insC.run(cid, O, `CUS-${custNo++}`, r.name, r.mobile, digits(r.mobile), r.email, r.company, now()); }
      const id = uid();
      insL.run({ id, org_id: O, code: `LD-${leadNo++}`, name: r.name, mobile: r.mobile, email: r.email, company: r.company, product_id: r.pid, source_id: r.src, project_id: r.proj, assigned_to: ass, status_id: r.st, follow_up_at: r.fu, customer_id: cid, created_by: me.id, created_at: now() });
      addHistory(id, me.id, "create", `Imported from ${file} (row ${r.n})${ass ? ` and assigned to ${nameOf("staff", ass)}` : ""}`);
      if (r.remark) addHistory(id, me.id, "remark", r.remark);
      if (ass) perAssignee.set(ass, (perAssignee.get(ass) || 0) + 1);
    }
    for (const [sid, n] of perAssignee) {
      if (sid === me.id) continue;
      sendAlert({ org: O, type: "newlead", title: `${n} new lead${n === 1 ? "" : "s"} assigned to you`, msg: `Uploaded by ${me.name} from ${file}`, from: me.id, to: [sid, getStaff(sid)?.reports_to] });
    }
  })();
  broadcast(O); res.json({ created: ok.length, errors, skipped, total: rows.length });
}));

app.put("/api/leads/:id", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "updateLead"); const l = loadLead(me, req.params.id); const b = req.body; const changes = [];
  const next = { name: str(b.name, 120) || l.name, mobile: str(b.mobile, 20) || l.mobile, email: str(b.email, 200), company: str(b.company, 120), source_id: l.source_id, project_id: l.project_id, product_id: l.product_id, assigned_to: l.assigned_to, status_id: l.status_id, follow_up_at: l.follow_up_at };
  if (b.sourceId && inOrg("sources", b.sourceId, O)) next.source_id = b.sourceId;
  if (b.projectId !== undefined) next.project_id = inOrg("projects", b.projectId, O) ? b.projectId : null;
  if (b.productId && b.productId !== l.product_id) { need(me, "assignProduct"); if (!inOrg("products", b.productId, O)) fail(400, "Unknown product."); next.product_id = b.productId; changes.push(`Product → ${nameOf("products", b.productId)}`); }
  if (b.assignedTo !== undefined && (b.assignedTo || null) !== l.assigned_to) {
    if (!can(me, "assignLead") && !can(me, "reassignLead")) fail(403, "Your role can't reassign leads.");
    if (b.assignedTo && (!reach(me).includes(b.assignedTo) || !usable(getStaff(b.assignedTo)))) fail(400, "You can't assign leads to that person.");
    next.assigned_to = b.assignedTo || null; changes.push(`Reassigned to ${nameOf("staff", next.assigned_to) || "Unassigned"}`);
  }
  if (b.statusId && b.statusId !== l.status_id) { need(me, "assignStatus"); if (!statusesFor(O, next.product_id).some(s => s.id === b.statusId)) fail(400, "That status doesn't apply to this product."); next.status_id = b.statusId; changes.push(`Status → ${nameOf("statuses", b.statusId)}`); }
  if (b.followUpAt !== undefined) next.follow_up_at = DT.test(b.followUpAt || "") ? b.followUpAt : "";
  db.transaction(() => {
    db.prepare(`UPDATE leads SET name=@name,mobile=@mobile,email=@email,company=@company,source_id=@source_id,project_id=@project_id,product_id=@product_id,assigned_to=@assigned_to,status_id=@status_id,follow_up_at=@follow_up_at,updated_at=@u WHERE id=@id`).run({ ...next, u: now(), id: l.id });
    addHistory(l.id, me.id, "edit", changes.length ? changes.join(" · ") : "Details updated");
    if (next.assigned_to && next.assigned_to !== l.assigned_to) newLeadAlert(O, { ...l, ...next }, next.assigned_to, me.id, "Lead reassigned to you");
  })();
  broadcast(O); res.json({ ok: true });
}));

app.post("/api/leads/:id/update", wrap((req, res) => {
  const me = req.me, O = me.org_id; const l = loadLead(me, req.params.id);
  if (!can(me, "updateLead") && l.assigned_to !== me.id) fail(403, "You can only update your own leads.");
  const b = req.body; const parts = []; let st = l.status_id;
  if (b.statusId && b.statusId !== l.status_id) { need(me, "assignStatus"); if (!statusesFor(O, l.product_id).some(s => s.id === b.statusId)) fail(400, "That status doesn't apply to this product."); st = b.statusId; parts.push(`Status → ${nameOf("statuses", st)}`); }
  let fu = DT.test(b.followUpAt || "") ? b.followUpAt : "";
  if (closedCat(statusCat(st))) fu = "";
  if (fu !== (l.follow_up_at || "")) parts.push(fu ? `Follow-up set for ${new Date(fu).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Follow-up cleared");
  if (str(b.remark, 2000)) parts.push(str(b.remark, 2000));
  if (!parts.length) fail(400, "Nothing changed.");
  db.transaction(() => { db.prepare("UPDATE leads SET status_id=?, follow_up_at=?, updated_at=? WHERE id=?").run(st, fu, now(), l.id); addHistory(l.id, me.id, "update", parts.join(" · ")); })();
  broadcast(O); res.json({ ok: true });
}));

app.post("/api/leads/:id/assign", wrap((req, res) => {
  const me = req.me, O = me.org_id; if (!can(me, "reassignLead") && !can(me, "assignLead")) fail(403, "Your role can't reassign leads.");
  const l = loadLead(me, req.params.id); const to = str(req.body.assignedTo, 64) || null;
  if (to === l.assigned_to) fail(400, "Already assigned to this person.");
  if (to && (!reach(me).includes(to) || !usable(getStaff(to)))) fail(400, "You can't assign leads to that person.");
  db.transaction(() => {
    db.prepare("UPDATE leads SET assigned_to=?, updated_at=? WHERE id=?").run(to, now(), l.id);
    addHistory(l.id, me.id, "assign", `Reassigned from ${nameOf("staff", l.assigned_to) || "Unassigned"} to ${nameOf("staff", to) || "Unassigned"}`);
    if (to) newLeadAlert(O, l, to, me.id, "Lead reassigned to you");
  })();
  broadcast(O); res.json({ ok: true });
}));

app.post("/api/leads/:id/log", wrap((req, res) => {
  const l = loadLead(req.me, req.params.id); const t = str(req.body.text, 500); if (!t) fail(400, "Nothing to log.");
  addHistory(l.id, req.me.id, "send", t); broadcast(req.me.org_id); res.json({ ok: true });
}));

/* ------------------------------------------------------------------ staff */
function staffBody(me, b, existing) {
  const O = me.org_id;
  const out = { name: str(b.name, 100), mobile: str(b.mobile, 20), email: str(b.email, 200).toLowerCase(), role_id: str(b.roleId, 64) || null, reports_to: str(b.reportsTo, 64) || null,
    on_time: /^\d{2}:\d{2}$/.test(b.onTime || "") ? b.onTime : "09:30", off_time: /^\d{2}:\d{2}$/.test(b.offTime || "") ? b.offTime : "18:30" };
  if (!out.name) fail(400, "Name is required.");
  if (!emailOk(out.email)) fail(400, "Enter a valid email.");
  const clash = db.prepare("SELECT name, org_id FROM staff WHERE email=? AND id<>?").get(out.email, existing?.id || "");
  if (clash) fail(400, clash.org_id === O ? `${clash.name} already uses that email.` : "That email is already registered with another company.");
  const role = getRole(out.role_id); if (!role || role.org_id !== O) fail(400, "Choose a role.");
  if (role.level === "superadmin" && !isSuper(me)) fail(403, "Only Super Admin can grant Super Admin.");
  if (out.reports_to && (!inOrg("staff", out.reports_to, O) || out.reports_to === existing?.id || (existing && descendants(existing.id, orgStaff(O)).includes(out.reports_to)))) fail(400, "Pick a valid manager.");
  if (existing?.password_hash && existing.email !== out.email && !isSuper(me)) out.email = existing.email;
  return out;
}
const setLinks = (table, col, id, ids, refTable, O) => {
  db.prepare(`DELETE FROM ${table} WHERE staff_id=?`).run(id);
  const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (staff_id,${col}) VALUES (?,?)`);
  ids.filter(x => inOrg(refTable, x, O)).forEach(x => ins.run(id, x));
};
const loadStaff = (me, id) => { const s = getStaff(id); if (!s || s.org_id !== me.org_id) fail(404, "Staff not found."); return s; };

app.post("/api/staff", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "manageStaff"); const v = staffBody(me, req.body, null);
  if (req.body.password && !pwOk(req.body.password)) fail(400, PW_RULE);
  checkLimit(O, "users");
  const id = uid();
  db.transaction(() => {
    db.prepare(`INSERT INTO staff (id,org_id,name,mobile,email,password_hash,role_id,reports_to,on_time,off_time,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(id, O, v.name, v.mobile, v.email, req.body.password ? bcrypt.hashSync(req.body.password, 10) : null, v.role_id, v.reports_to, v.on_time, v.off_time, now());
    setLinks("staff_projects", "project_id", id, arr(req.body.projects), "projects", O); setLinks("staff_products", "product_id", id, arr(req.body.products), "products", O);
    addStaffLog(id, me.id, "Created");
  })();
  broadcast(O); res.json({ id });
}));
app.put("/api/staff/:id", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "manageStaff"); const s = loadStaff(me, req.params.id);
  if (getRole(s.role_id)?.level === "superadmin" && !isSuper(me)) fail(403, "Only Super Admin can edit a Super Admin.");
  const v = staffBody(me, req.body, s);
  db.transaction(() => {
    db.prepare("UPDATE staff SET name=?,mobile=?,email=?,role_id=?,reports_to=?,on_time=?,off_time=? WHERE id=?").run(v.name, v.mobile, v.email, v.role_id, v.reports_to, v.on_time, v.off_time, s.id);
    setLinks("staff_projects", "project_id", s.id, arr(req.body.projects), "projects", O); setLinks("staff_products", "product_id", s.id, arr(req.body.products), "products", O);
    if (s.role_id !== v.role_id) addStaffLog(s.id, me.id, `Role changed to ${nameOf("roles", v.role_id)}`);
  })();
  broadcast(O); res.json({ ok: true });
}));
app.post("/api/staff/:id/toggle", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "manageStaff"); const s = loadStaff(me, req.params.id);
  if (s.id === me.id) fail(400, "You can't deactivate yourself.");
  if (getRole(s.role_id)?.level === "superadmin" && !isSuper(me)) fail(403, "Only Super Admin can do this.");
  const reason = str(req.body.reason, 500); if (!reason) fail(400, "Add a reason.");
  if (!s.active && !s.demo_password) checkLimit(O, "users");
  db.prepare("UPDATE staff SET active=? WHERE id=?").run(s.active ? 0 : 1, s.id); addStaffLog(s.id, me.id, s.active ? "Deactivated" : "Activated", reason);
  broadcast(O); res.json({ active: !s.active });
}));
app.post("/api/staff/:id/approve", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "manageStaff"); const s = loadStaff(me, req.params.id); if (!s.pending) fail(404, "Request not found.");
  const role = getRole(req.body.roleId); if (!role || role.org_id !== O) fail(400, "Choose a role."); if (role.level === "superadmin" && !isSuper(me)) fail(403, "Only Super Admin can grant Super Admin.");
  const rt = str(req.body.reportsTo, 64) || null; if (rt && !inOrg("staff", rt, O)) fail(400, "Pick a valid manager.");
  checkLimit(O, "users");
  db.transaction(() => {
    db.prepare("UPDATE staff SET pending=0, active=1, role_id=?, reports_to=? WHERE id=?").run(role.id, rt, s.id);
    setLinks("staff_products", "product_id", s.id, arr(req.body.products), "products", O);
    addStaffLog(s.id, me.id, `Approved as ${role.name}`);
  })();
  broadcast(O); res.json({ ok: true });
}));
app.post("/api/staff/:id/reject", wrap((req, res) => {
  const me = req.me; need(me, "manageStaff"); const s = loadStaff(me, req.params.id); if (!s.pending) fail(404, "Request not found.");
  db.prepare("UPDATE staff SET pending=0, rejected=1, active=0 WHERE id=?").run(s.id); addStaffLog(s.id, me.id, "Sign-up declined");
  broadcast(me.org_id); res.json({ ok: true });
}));
app.post("/api/staff/:id/password", wrap((req, res) => {
  const me = req.me; need(me, "manageStaff"); const s = loadStaff(me, req.params.id);
  if (getRole(s.role_id)?.level === "superadmin" && !isSuper(me)) fail(403, "Only Super Admin can reset a Super Admin's password.");
  if (!pwOk(req.body.password)) fail(400, PW_RULE);
  db.prepare("UPDATE staff SET password_hash=?, demo_password=NULL WHERE id=?").run(bcrypt.hashSync(req.body.password, 10), s.id);
  addStaffLog(s.id, me.id, "Password reset by admin"); broadcast(me.org_id); res.json({ ok: true });
}));

/* ------------------------------------------------------------------ masters (upsert, company-scoped) */
function claim(table, id, O) {
  const row = db.prepare(`SELECT org_id FROM ${table} WHERE id=?`).get(id);
  if (row && row.org_id !== O) fail(404, "Not found.");
  return !!row;
}
const linkProducts = (table, col, id, ids, O) => {
  db.prepare(`DELETE FROM ${table} WHERE ${col}=?`).run(id);
  return ids.filter(p => inOrg("products", p, O));
};
const MASTERS = {
  roles: { perm: "manageStaff", save(me, id, b, O, exists) {
    const ex = exists && getRole(id); if (ex?.level === "superadmin") fail(400, "Super Admin always has every rule.");
    const name = str(b.name, 60); if (!name) fail(400, "Role name is required.");
    const scope = SCOPES.includes(b.scope) ? b.scope : "own";
    const perms = JSON.stringify(Object.fromEntries(PERMS.map(k => [k, !!(b.perms || {})[k]])));
    if (ex) db.prepare("UPDATE roles SET name=?, scope=?, perms=? WHERE id=?").run(name, scope, perms, id);
    else db.prepare("INSERT INTO roles (id,org_id,name,level,scope,perms,sort) VALUES (?,?,?,?,?,?,?)").run(id, O, name, "custom", scope, perms, 50 + db.prepare("SELECT COUNT(*) n FROM roles WHERE org_id=?").get(O).n);
  } },
  statuses: { perm: "manageMasters", save(me, id, b, O, exists) {
    const name = str(b.name, 60); if (!name) fail(400, "Status name is required.");
    const cat = CATS.includes(b.cat) ? b.cat : "open", sort = Number.isFinite(+b.order) ? +b.order : 50, active = b.active === false ? 0 : 1;
    if (exists) db.prepare("UPDATE statuses SET name=?, cat=?, sort=?, active=? WHERE id=?").run(name, cat, sort, active, id);
    else db.prepare("INSERT INTO statuses (id,org_id,name,cat,sort,active) VALUES (?,?,?,?,?,?)").run(id, O, name, cat, sort, active);
    const ins = db.prepare("INSERT OR IGNORE INTO status_products (status_id,product_id) VALUES (?,?)");
    linkProducts("status_products", "status_id", id, arr(b.products), O).forEach(p => ins.run(id, p));
  } },
  sources: { perm: "manageMasters", save(me, id, b, O, exists) {
    const name = str(b.name, 60); if (!name) fail(400, "Source name is required.");
    if (exists) db.prepare("UPDATE sources SET name=?, industry=?, active=? WHERE id=?").run(name, str(b.industry, 60), b.active === false ? 0 : 1, id);
    else db.prepare("INSERT INTO sources (id,org_id,name,industry,active) VALUES (?,?,?,?,?)").run(id, O, name, str(b.industry, 60), b.active === false ? 0 : 1);
  } },
  products: { perm: "manageMasters", save(me, id, b, O, exists) {
    const name = str(b.name, 80); if (!name) fail(400, "Product name is required.");
    if (exists) db.prepare("UPDATE products SET name=?, description=?, active=? WHERE id=?").run(name, str(b.description, 300), b.active === false ? 0 : 1, id);
    else db.prepare("INSERT INTO products (id,org_id,name,description,active,created_at) VALUES (?,?,?,?,?,?)").run(id, O, name, str(b.description, 300), b.active === false ? 0 : 1, now());
    db.prepare("DELETE FROM product_projects WHERE product_id=?").run(id);
    const ins = db.prepare("INSERT OR IGNORE INTO product_projects (product_id,project_id) VALUES (?,?)");
    arr(b.projectIds).filter(p => inOrg("projects", p, O)).forEach(p => ins.run(id, p));
  } },
  projects: { perm: "manageMasters", save(me, id, b, O, exists) {
    const name = str(b.name, 80); if (!name) fail(400, "Project name is required.");
    if (exists) db.prepare("UPDATE projects SET name=?, industry=? WHERE id=?").run(name, str(b.industry, 60), id);
    else db.prepare("INSERT INTO projects (id,org_id,name,industry,created_at) VALUES (?,?,?,?,?)").run(id, O, name, str(b.industry, 60), now());
  } },
  templates: { perm: "manageMasters", save(me, id, b, O, exists) {
    const name = str(b.name, 80), body = str(b.body, 5000); if (!name || !body) fail(400, "Template name and message are required.");
    const ch = CHANNELS.includes(b.channel) ? b.channel : "email"; const pid = inOrg("products", b.productId, O) ? b.productId : null;
    if (exists) db.prepare("UPDATE templates SET name=?, channel=?, type=?, product_id=?, subject=?, body=? WHERE id=?").run(name, ch, str(b.type, 30) || "General", pid, str(b.subject, 200), body, id);
    else db.prepare("INSERT INTO templates (id,org_id,name,channel,type,product_id,subject,body,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, O, name, ch, str(b.type, 30) || "General", pid, str(b.subject, 200), body, now());
  } },
};

/* ------------------------------------------------------------------ company settings & billing */
app.put("/api/org", wrap((req, res) => {
  needSuper(req.me); const name = str(req.body.name, 100); if (name.length < 2) fail(400, "Enter a company name.");
  db.prepare("UPDATE orgs SET name=? WHERE id=?").run(name, req.me.org_id); broadcast(req.me.org_id); res.json({ ok: true });
}));
app.post("/api/org/code", wrap((req, res) => {
  needSuper(req.me);
  const base = (req.me.org.name.replace(/[^A-Za-z]/g, "").slice(0, 4) || "ORG").toUpperCase();
  let code; do { code = `${base}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`; } while (db.prepare("SELECT 1 FROM orgs WHERE code=?").get(code));
  db.prepare("UPDATE orgs SET code=? WHERE id=?").run(code, req.me.org_id); broadcast(req.me.org_id); res.json({ code });
}));
app.post("/api/billing/subscribe", wrap(async (req, res) => {
  const me = req.me; needSuper(me);
  if (!billingOn()) fail(503, "Online payments aren't set up yet. Contact Pulse Shift Media to upgrade your plan.");
  const plan = PLANS[req.body.plan]; if (!plan || !PAID.includes(plan.id)) fail(400, "Pick a paid plan.");
  const planId = process.env[plan.rzpEnv]; if (!planId) fail(503, `The ${plan.name} plan isn't set up for online payment yet.`);
  const sub = await rzp("POST", "/subscriptions", { plan_id: planId, total_count: 120, quantity: 1, customer_notify: 1, notes: { org_id: me.org_id, plan: plan.id, company: me.org.name } });
  db.prepare("UPDATE orgs SET rzp_subscription_id=?, rzp_subscription_status=? WHERE id=?").run(sub.id, sub.status || "created", me.org_id);
  res.json({ keyId: RZP.key, subscriptionId: sub.id, plan: plan.id, name: me.org.name, email: me.email, contact: me.mobile });
}));
app.post("/api/billing/verify", wrap((req, res) => {
  const me = req.me; needSuper(me);
  const { razorpay_payment_id: pay, razorpay_subscription_id: sub, razorpay_signature: sig } = req.body || {};
  if (!pay || !sub || !sig) fail(400, "Missing payment details.");
  if (sub !== me.org.rzp_subscription_id) fail(400, "That subscription doesn't belong to your company.");
  const expect = crypto.createHmac("sha256", RZP.secret).update(`${pay}|${sub}`).digest("hex");
  if (!safeEq(sig, expect)) fail(400, "Payment signature didn't match. If money was taken, contact Pulse Shift Media support with your payment ID.");
  const plan = PAID.includes(req.body.plan) ? req.body.plan : "pro";
  activatePaid(me.org_id, plan, { paymentId: pay, subId: sub, amount: PLANS[plan].price * 100 });
  res.json({ ok: true, plan });
}));
app.post("/api/billing/cancel", wrap(async (req, res) => {
  const me = req.me; needSuper(me); const sub = me.org.rzp_subscription_id; if (!sub) fail(400, "No active subscription.");
  if (billingOn()) await rzp("POST", `/subscriptions/${sub}/cancel`, { cancel_at_cycle_end: 1 });
  db.prepare("UPDATE orgs SET rzp_subscription_status='cancelled' WHERE id=?").run(me.org_id); broadcast(me.org_id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ platform admin (Pulse Shift Media) */
const needPlatform = me => { if (!me.platform_admin) fail(403, "Platform admins only."); };
app.get("/api/platform/orgs", wrap((req, res) => {
  needPlatform(req.me);
  const rows = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM staff s WHERE s.org_id=o.id AND s.active=1 AND s.pending=0 AND s.demo_password IS NULL) users,
    (SELECT COUNT(*) FROM leads l WHERE l.org_id=o.id) leads, (SELECT COUNT(*) FROM leads l WHERE l.org_id=o.id AND l.created_at>=?) leadsMonth,
    (SELECT s.email FROM staff s JOIN roles r ON r.id=s.role_id WHERE s.org_id=o.id AND r.level='superadmin' AND s.demo_password IS NULL ORDER BY s.created_at LIMIT 1) ownerEmail,
    (SELECT MAX(last_login_at) FROM staff s WHERE s.org_id=o.id) lastActive,
    (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.org_id=o.id) paid
    FROM orgs o ORDER BY o.created_at DESC`).all(monthStart());
  res.json(rows.map(o => { const eff = effectivePlan(o); return { id: o.id, name: o.name, code: o.code, plan: o.plan, effective: eff.id, effectiveName: eff.name, status: o.status, trialEndsAt: o.trial_ends_at, paidUntil: o.paid_until,
    subscriptionStatus: o.rzp_subscription_status, users: o.users, leads: o.leads, leadsMonth: o.leadsMonth, ownerEmail: o.ownerEmail, lastActive: o.lastActive, paid: o.paid, createdAt: o.created_at, mrr: PAID.includes(eff.id) ? eff.price : 0, self: o.id === req.me.org_id }; }));
}));
app.put("/api/platform/orgs/:id", wrap((req, res) => {
  needPlatform(req.me); const o = getOrg(req.params.id); if (!o) fail(404, "Company not found.");
  const b = req.body;
  if (b.status !== undefined) { if (!["active", "suspended"].includes(b.status)) fail(400, "Bad status."); if (o.id === req.me.org_id && b.status !== "active") fail(400, "You can't suspend your own company."); db.prepare("UPDATE orgs SET status=? WHERE id=?").run(b.status, o.id); }
  if (b.plan !== undefined) {
    if (!PLANS[b.plan]) fail(400, "Unknown plan.");
    const days = Math.max(0, Math.min(3650, Number(b.days) || 0));
    if (b.plan === "trial") db.prepare("UPDATE orgs SET plan='trial', trial_ends_at=? WHERE id=?").run(now() + (days || 14) * 864e5, o.id);
    else db.prepare("UPDATE orgs SET plan=?, paid_until=? WHERE id=?").run(b.plan, PAID.includes(b.plan) ? (days ? now() + days * 864e5 : null) : null, o.id);
    if (PAID.includes(b.plan)) db.prepare("INSERT INTO payments (id,org_id,provider,plan,amount,status,at) VALUES (?,?,?,?,?,?,?)").run(uid(), o.id, "manual", b.plan, Math.round((Number(b.amount) || 0) * 100), "recorded", now());
  }
  broadcast(o.id); res.json({ ok: true });
}));
app.delete("/api/platform/orgs/:id", wrap((req, res) => {
  needPlatform(req.me); const o = getOrg(req.params.id); if (!o) fail(404, "Company not found."); if (o.id === req.me.org_id) fail(400, "You can't delete your own company.");
  if (str(req.body?.confirm, 100) !== o.name) fail(400, "Type the company name exactly to confirm.");
  db.transaction(() => {
    db.prepare("DELETE FROM lead_history WHERE lead_id IN (SELECT id FROM leads WHERE org_id=?)").run(o.id);
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const t of ["alerts", "leads", "customers", "templates", "statuses", "sources", "products", "projects"]) db.prepare(`DELETE FROM ${t} WHERE org_id=?`).run(o.id);
    db.prepare("UPDATE staff SET reports_to=NULL, role_id=NULL WHERE org_id=?").run(o.id);
    db.prepare("DELETE FROM staff WHERE org_id=?").run(o.id); db.prepare("DELETE FROM roles WHERE org_id=?").run(o.id);
    db.prepare("DELETE FROM payments WHERE org_id=?").run(o.id); db.prepare("DELETE FROM orgs WHERE id=?").run(o.id);
  })();
  res.json({ ok: true });
}));

/* masters upsert after specific routes so /api/org etc. aren't swallowed */
app.put("/api/:col/:id", wrap((req, res, next) => {
  const m = MASTERS[req.params.col]; if (!m) return next(); need(req.me, m.perm);
  const id = str(req.params.id, 64); if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(400, "Bad id.");
  const O = req.me.org_id;
  db.transaction(() => m.save(req.me, id, req.body || {}, O, claim(req.params.col, id, O)))(); broadcast(O); res.json({ ok: true });
}));

/* ------------------------------------------------------------------ delete (Super Admin only) */
const USED = { statuses: "status_id", sources: "source_id", products: "product_id", projects: "project_id" };
const DELETABLE = ["leads","customers","staff","roles","statuses","sources","products","projects","templates"];
app.delete("/api/:col/:id", wrap((req, res, next) => {
  const { col, id } = req.params; if (!DELETABLE.includes(col)) return next(); needSuper(req.me); const O = req.me.org_id;
  if (!inOrg(col, id, O)) fail(404, "Not found.");
  if (col === "staff") {
    if (id === req.me.id) fail(400, "You can't delete yourself.");
    const n = db.prepare("SELECT COUNT(*) n FROM leads WHERE assigned_to=?").get(id).n; if (n) fail(409, `Reassign this person's ${n} leads first.`);
    db.prepare("UPDATE leads SET created_by=NULL WHERE created_by=?").run(id);
  }
  if (col === "roles") { if (getRole(id).system) fail(400, "This role can't be deleted."); const n = db.prepare("SELECT COUNT(*) n FROM staff WHERE role_id=?").get(id).n; if (n) fail(409, `${n} staff have this role. Change their role first.`); }
  if (USED[col]) { const n = db.prepare(`SELECT COUNT(*) n FROM leads WHERE ${USED[col]}=?`).get(id).n; if (n) fail(409, `Used by ${n} leads. Mark it inactive instead.`); }
  if (col === "customers") { const n = db.prepare("SELECT COUNT(*) n FROM leads WHERE customer_id=?").get(id).n; if (n) fail(409, `This customer has ${n} leads. Delete those first.`); }
  if (col === "leads") db.prepare("DELETE FROM alerts WHERE lead_id=?").run(id);
  db.prepare(`DELETE FROM ${col} WHERE id=? AND org_id=?`).run(id, O); broadcast(O); res.json({ ok: true });
}));

/* ------------------------------------------------------------------ alerts */
app.post("/api/alerts", wrap((req, res) => {
  const me = req.me, O = me.org_id; need(me, "sendAlert");
  const title = str(req.body.title, 200); if (!title) fail(400, "Add a title.");
  const allowed = new Set(reach(me).filter(id => id !== me.id && usable(getStaff(id))));
  const to = arr(req.body.to).filter(id => allowed.has(id)); if (!to.length) fail(400, "No one to send to.");
  const lvl = me.role?.level; const type = ["superadmin", "admin"].includes(lvl) ? "admin" : lvl === "manager" ? "manager" : lvl === "tl" ? "tl" : "admin";
  sendAlert({ org: O, type, title, msg: req.body.msg, from: me.id, to }); broadcast(O); res.json({ sent: to.length });
}));
app.post("/api/alerts/read-all", wrap((req, res) => { db.prepare("UPDATE alert_recipients SET read_at=? WHERE staff_id=? AND read_at IS NULL").run(now(), req.me.id); res.json({ ok: true }); }));
app.post("/api/alerts/:id/read", wrap((req, res) => { db.prepare("UPDATE alert_recipients SET read_at=? WHERE alert_id=? AND staff_id=? AND read_at IS NULL").run(now(), req.params.id, req.me.id); res.json({ ok: true }); }));

/* ------------------------------------------------------------------ clear sample data (this company only) */
app.post("/api/sample/clear", wrap((req, res) => {
  needSuper(req.me); const O = req.me.org_id;
  const r = db.transaction(() => {
    const c = {};
    c.leads = db.prepare("DELETE FROM leads WHERE org_id=? AND sample=1").run(O).changes;
    db.prepare("DELETE FROM alerts WHERE org_id=? AND (sample=1 OR (lead_id IS NOT NULL AND lead_id NOT IN (SELECT id FROM leads)))").run(O);
    c.customers = db.prepare("DELETE FROM customers WHERE org_id=? AND sample=1 AND id NOT IN (SELECT customer_id FROM leads WHERE customer_id IS NOT NULL)").run(O).changes;
    db.prepare("DELETE FROM templates WHERE org_id=? AND sample=1").run(O);
    for (const s of db.prepare("SELECT id FROM staff WHERE org_id=? AND sample=1").all(O)) {
      for (const l of db.prepare("SELECT id FROM leads WHERE assigned_to=?").all(s.id)) { db.prepare("UPDATE leads SET assigned_to=NULL WHERE id=?").run(l.id); addHistory(l.id, req.me.id, "assign", "Unassigned because a sample staff account was removed"); }
      db.prepare("UPDATE leads SET created_by=NULL WHERE created_by=?").run(s.id);
    }
    c.staff = db.prepare("DELETE FROM staff WHERE org_id=? AND sample=1").run(O).changes;
    c.products = db.prepare("DELETE FROM products WHERE org_id=? AND sample=1 AND id NOT IN (SELECT product_id FROM leads WHERE product_id IS NOT NULL)").run(O).changes;
    c.projects = db.prepare("DELETE FROM projects WHERE org_id=? AND sample=1 AND id NOT IN (SELECT project_id FROM leads WHERE project_id IS NOT NULL)").run(O).changes;
    return c;
  })();
  broadcast(O); res.json(r);
}));

/* ------------------------------------------------------------------ static frontend + errors */
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: "1h" }));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request body." });
  console.error(err); res.status(500).json({ error: "Something went wrong on the server." });
});

for (const r of db.prepare("SELECT id, perms FROM roles").all()) { const p = JSON.parse(r.perms || "{}"); if (!("uploadLeads" in p)) { p.uploadLeads = true; db.prepare("UPDATE roles SET perms=? WHERE id=?").run(JSON.stringify(p), r.id); } }
if (!db.prepare("SELECT 1 FROM orgs").get()) console.warn("Database is empty. Run `npm run seed` first, or open the app and choose Sign up → Start a company.");
app.listen(PORT, () => console.log(`Pulse Shift LMS running at http://localhost:${PORT} · SQLite via ${db.driver || "better-sqlite3"}${billingOn() ? " · Razorpay billing on" : " · Razorpay billing off (no keys)"}`));
