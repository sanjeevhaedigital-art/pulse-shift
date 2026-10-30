// Seeds Pulse Shift LMS (SaaS): the Pulse Shift Media company with the owner, demo logins and sample data, plus one example customer company.
// Usage: npm run seed            (only seeds an empty database)
//        npm run seed -- --reset (wipes everything first)
require("./env");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { createOrg } = require("./tenant");

const reset = process.argv.includes("--reset");
const now = Date.now(), H = 3600e3, D = 24 * H;
const hash = pw => bcrypt.hashSync(pw, 10);

if (reset) {
  const tables = ["alert_recipients","alerts","lead_history","leads","customers","templates","status_products","statuses","sources","staff_products","staff_projects","product_projects","products","projects","staff_log","staff","roles","payments","orgs"];
  db.exec("PRAGMA foreign_keys = OFF;" + tables.map(t => `DELETE FROM ${t};`).join("") + "PRAGMA foreign_keys = ON;");
  console.log("Database cleared.");
} else if (db.prepare("SELECT COUNT(*) n FROM orgs").get().n > 0) {
  console.log("Database already has data. Run `npm run seed -- --reset` to start over.");
  process.exit(0);
}

const DEMO = (process.env.SEED_DEMO || "true") !== "false";
const ownerEmail = (process.env.OWNER_EMAIL || "owner@pulseshiftmedia.com").toLowerCase();
const ownerPw = process.env.OWNER_PASSWORD || "ChangeMe@123";

db.transaction(() => {
  /* ================= Pulse Shift Media (platform owner company, Dubai) ================= */
  const psm = createOrg(process.env.OWNER_COMPANY || "Pulse Shift Media", { id: "org_psm", plan: "business", code: "PSM-0001" });
  const O = psm.orgId, R = psm.roles, ST = psm.statuses, SRC = psm.sources;
  db.prepare("UPDATE orgs SET paid_until=NULL WHERE id=?").run(O);

  const staff = db.prepare(`INSERT INTO staff (id,org_id,name,mobile,email,password_hash,demo_password,role_id,reports_to,on_time,off_time,active,platform_admin,sample,created_at)
    VALUES (@id,@org,@name,@mobile,@email,@hash,@demo,@role,@rt,@on,@off,@active,@pa,@sample,@at)`);
  const slog = db.prepare("INSERT INTO staff_log (staff_id,at,by_id,action,reason) VALUES (?,?,?,?,?)");
  staff.run({ id: "st_owner", org: O, name: process.env.OWNER_NAME || "Navjot Kaur", mobile: "", email: ownerEmail, hash: hash(ownerPw), demo: null, role: R.superadmin, rt: null, on: "09:30", off: "18:30", active: 1, pa: 1, sample: 0, at: now });
  slog.run("st_owner", now, null, "Created as owner and platform admin", "");
  if (!DEMO) return;

  const pj = db.prepare("INSERT INTO projects (id,org_id,name,industry,sample,created_at) VALUES (?,?,?,?,1,?)");
  pj.run("pj_social", O, "Social & Content", "Digital Marketing", now); pj.run("pj_perf", O, "Performance Marketing", "Digital Marketing", now); pj.run("pj_web", O, "Web & Tech", "Digital Marketing", now);
  const pr = db.prepare("INSERT INTO products (id,org_id,name,description,active,sample,created_at) VALUES (?,?,?,'',1,1,?)");
  const pp = db.prepare("INSERT INTO product_projects (product_id,project_id) VALUES (?,?)");
  const prods = [["pr_smm","Social Media Management","pj_social"],["pr_tts","TikTok Shop Setup","pj_social"],["pr_ads","Meta & Google Ads","pj_perf"],["pr_seo","SEO & AEO","pj_perf"],["pr_web","Website Development","pj_web"]];
  prods.forEach(([id, n, p]) => { pr.run(id, O, n, now); pp.run(id, p); });

  const t0 = now - 30 * D;
  const sp = db.prepare("INSERT INTO staff_projects (staff_id,project_id) VALUES (?,?)");
  const sd = db.prepare("INSERT INTO staff_products (staff_id,product_id) VALUES (?,?)");
  const demo = (id, name, mobile, email, pw, lvl, rt, products = [], projects = [], on = "09:30", off = "18:30", active = 1) => {
    staff.run({ id, org: O, name, mobile, email, hash: hash(pw), demo: pw, role: R[lvl], rt, on, off, active, pa: 0, sample: 1, at: t0 });
    products.forEach(p => sd.run(id, p)); projects.forEach(p => sp.run(id, p));
    slog.run(id, t0, "st_owner", "Created as demo login", "");
  };
  demo("st_demosuper","Demo Super Admin","0500000000","superadmin@pulseshift.demo","Super@123","superadmin",null,[],[],"00:00","23:59");
  demo("st_admin","Layla Haddad","0501110002","admin@pulseshift.demo","Admin@123","admin","st_owner");
  demo("st_mgr","Omar Al Suwaidi","0501110003","manager@pulseshift.demo","Manager@123","manager","st_admin");
  demo("st_tl1","Priya Menon","0501110004","teamlead@pulseshift.demo","Leader@123","tl","st_mgr",["pr_smm","pr_tts","pr_web"],["pj_social","pj_web"]);
  demo("st_tl2","Karim Nassar","0501110005","teamlead2@pulseshift.demo","Leader@123","tl","st_mgr",["pr_ads","pr_seo"],["pj_perf"]);
  demo("st_coord","Fatima Rahman","0501110006","coordinator@pulseshift.demo","Coord@123","coordinator","st_mgr");
  demo("st_tc1","Arjun Pillai","0501110007","telecaller@pulseshift.demo","Caller@123","telecaller","st_tl1",["pr_smm","pr_web"],["pj_social","pj_web"]);
  demo("st_tc2","Hana Yousef","0501110008","telecaller2@pulseshift.demo","Caller@123","telecaller","st_tl1",["pr_tts","pr_smm"],["pj_social"],"12:00","21:00");
  demo("st_tc3","Ryan D'Souza","0501110009","telecaller3@pulseshift.demo","Caller@123","telecaller","st_tl2",["pr_ads"],["pj_perf"]);
  demo("st_tc4","Noor Khalil","0501110010","telecaller4@pulseshift.demo","Caller@123","telecaller","st_tl2",["pr_seo","pr_ads"],["pj_perf"]);
  demo("st_acc","Ahmed Farouk","0501110011","accounts@pulseshift.demo","Accounts@123","accounts","st_admin");
  demo("st_left","Sami Haddad","0501110012","sami@pulseshift.demo","Caller@123","telecaller","st_tl2",["pr_seo"],["pj_perf"],"09:30","18:30",0);
  slog.run("st_left", now - 4 * D, "st_admin", "Deactivated", "Resigned, last working day 24 Oct");

  // sample customers & leads
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const prodStaff = { pr_smm: ["st_tc1","st_tc2"], pr_tts: ["st_tc2"], pr_ads: ["st_tc3","st_tc4"], pr_seo: ["st_tc4"], pr_web: ["st_tc1"] };
  const srcNames = ["Manual","Website","Website","Google Ads","Meta Ads","Meta Ads","Instagram","Instagram","WhatsApp","WhatsApp","LinkedIn","Referral","Landing Page"];
  const people = [["Rashid Al Mansoori","Al Mansoori Trading"],["Sara Qureshi",""],["Daniel Brooks","Brooks Fitness Studio"],["Aisha Al Hammadi",""],["Vikram Shetty","Shetty Spices LLC"],["Mariam Saeed",""],["Khalid Bin Zayed","Desert Rose Perfumes"],["Elena Petrova",""],["Faisal Kareem","Kareem Auto Parts"],["Ritu Malhotra","Bloom Café JLT"],["Youssef Haddad",""],["Nadia Farooq","Nadia Couture"],["Tom Fletcher",""],["Hamad Al Ketbi","Ketbi Real Estate"],["Leila Mansour",""],["Ankit Jain","Spice Route Restaurant"],["Grace Okafor",""],["Mohammed Al Nuaimi","Nuaimi Logistics"],["Sofia Romano",""],["Imran Sheikh","Marina Dental Clinic"],["Huda Al Falasi",""],["Joseph Mathew","Al Barsha Electronics"],["Chloe Martin",""],["Tariq Aziz","Aziz Interiors"]];
  const plan = ["new","new","new","cont","int","fu","fu","fu","prop","prop","quote","conv","conv","conv","ni","inv","new","int","fu","quote","conv","ni","cont","fu"];
  const stName = { new:"New",cont:"Contacted",int:"Interested",fu:"Follow-up",prop:"Proposal Sent",quote:"Quotation Sent",conv:"Converted",ni:"Not Interested",inv:"Invalid Number" };
  const pids = prods.map(p => p[0]), projOf = Object.fromEntries(prods.map(([k,,p]) => [k, p]));
  const notes = ["Called, wants a 3-month retainer quote in AED","Spoke to client, sharing portfolio on WhatsApp","Asked for a callback after Asr, around 4 pm","Comparing us with two other Dubai agencies","Discovery call done, budget confirmed"];
  const localDT = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes() < 30 ? 0 : 30)}`; };
  const cust = db.prepare("INSERT INTO customers (id,org_id,code,name,mobile,mobile_digits,email,company,sample,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)");
  const lead = db.prepare(`INSERT INTO leads (id,org_id,code,name,mobile,email,company,product_id,source_id,project_id,assigned_to,status_id,follow_up_at,customer_id,created_by,created_at,sample)
    VALUES (@id,@org,@code,@name,@mobile,@email,@company,@pid,@src,@proj,@ass,@st,@fu,@cid,@by,@at,1)`);
  const hist = db.prepare("INSERT INTO lead_history (lead_id,at,by_id,kind,text) VALUES (?,?,?,?,?)");
  people.forEach(([name, company], i) => {
    const pid = pids[i % 5]; const ass = i === 5 ? null : pick(prodStaff[pid]);
    const days = i < 4 ? 0 : 1 + Math.floor(rnd() * 12);
    const at = days === 0 ? now - (20 + Math.floor(rnd() * 280)) * 60e3 : now - days * D - Math.floor(rnd() * 5) * H;
    const s = plan[i]; let fu = "";
    if (["fu","prop","quote","int","cont"].includes(s)) fu = localDT(now + pick([-26,-3,1,2,20,44,70]) * H);
    const mobile = "05" + String(52000000 + i * 37311).slice(0, 8);
    const email = i % 3 ? `${name.split(" ")[0].toLowerCase()}.${name.split(" ")[1].toLowerCase()}@example.com` : "";
    const cid = "c_" + String(i).padStart(2, "0"); cust.run(cid, O, "CUS-" + (1001 + i), name, mobile, mobile, email, company, at);
    const sn = pick(srcNames); const by = i % 2 ? "st_coord" : (ass || "st_coord"); const id = "l_" + String(i).padStart(2, "0");
    lead.run({ id, org: O, code: "LD-" + (2001 + i), name, mobile, email, company, pid, src: SRC[sn], proj: projOf[pid], ass, st: ST[s], fu, cid, by, at });
    hist.run(id, at, by, "create", `Lead created from ${sn}${ass ? " and assigned" : ""}`);
    if (s !== "new") hist.run(id, at + 3 * H, ass || "st_coord", "update", `Status → ${stName[s]} · ${pick(notes)}`);
  });
  const old = now - 95 * D, m2 = db.prepare("SELECT mobile FROM customers WHERE id='c_02'").get().mobile;
  lead.run({ id: "l_old1", org: O, code: "LD-1990", name: "Daniel Brooks", mobile: m2, email: "", company: "Brooks Fitness Studio", pid: "pr_smm", src: SRC.Referral, proj: "pj_social", ass: "st_tc1", st: ST.conv, fu: "", cid: "c_02", by: "st_tc1", at: old });
  hist.run("l_old1", old, "st_tc1", "create", "Lead created from Referral");
  hist.run("l_old1", old + 6 * D, "st_tc1", "update", "Status → Converted · 6-month Instagram and TikTok retainer signed");

  const tp = db.prepare("INSERT INTO templates (id,org_id,name,channel,type,product_id,subject,body,sample,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)");
  tp.run("t_prop", O, "Social media proposal", "email", "Proposal", "pr_smm", "Proposal: social media management for {company}", "Hi {name},\n\nThanks for your time on the call. Attached is our proposal for managing {company}'s Instagram, TikTok and LinkedIn, covering content, reels, community management and monthly reporting.\n\nWe can start within 7 working days of sign-off.\n\nReply here or call me on {staff_mobile} with any questions.\n\nRegards,\n{staff}\nPulse Shift Media, Dubai", now);
  tp.run("t_quote", O, "Standard quotation", "email", "Quotation", null, "Quotation for {product} · {lead_id}", "Hi {name},\n\nPlease find the quotation for {product} below. Prices are in AED, exclusive of 5% VAT, and valid for 15 days.\n\n[Add line items here]\n\nRegards,\n{staff}\n{staff_mobile}", now);
  tp.run("t_req", O, "Discovery brief", "email", "Requirement", null, "Next step: a few details for {product}", "Hi {name},\n\nTo build your plan for {product}, please share:\n1. Your goals for the next 3 months\n2. Monthly budget in AED\n3. Markets you want to reach (UAE, GCC, international)\n4. Preferred start date\n\nRegards,\n{staff}", now);
  tp.run("t_wa", O, "Follow-up nudge", "whatsapp", "Follow-up", null, "", "Hi {name}, {staff} here from Pulse Shift Media. Just following up on {product}. Is now a good time for a quick call?", now);
  tp.run("t_sms", O, "Missed call", "sms", "Follow-up", null, "", "Hi {name}, we tried reaching you about {product}. Call {staff} on {staff_mobile}. Ref {lead_id}", now);
  const al = db.prepare("INSERT INTO alerts (id,org_id,type,title,msg,lead_id,from_id,at,sample) VALUES (?,?,?,?,?,NULL,?,?,1)");
  const ar = db.prepare("INSERT INTO alert_recipients (alert_id,staff_id,read_at) VALUES (?,?,?)");
  al.run("a_1", O, "admin", "Update every follow-up before 6 pm", "Weekly review is on Thursday. Leads without a remark in 48 hours will be reassigned.", "st_admin", now - 5 * H);
  db.prepare("SELECT id FROM staff WHERE org_id=? AND active=1 AND id<>'st_admin'").all(O).forEach(r => ar.run("a_1", r.id, null));
  al.run("a_2", O, "tl", "Send TikTok Shop quotes today", "Two TikTok Shop leads are waiting on pricing.", "st_tl1", now - 2 * H);
  ar.run("a_2", "st_tc1", null); ar.run("a_2", "st_tc2", null);

  /* ================= Example customer company (shows how other businesses use the SaaS) ================= */
  const sky = createOrg("Marina Heights Properties", { id: "org_marina", plan: "trial", now: now - 6 * D });
  staff.run({ id: "st_sky_owner", org: sky.orgId, name: "Ali Rahimi", mobile: "0559100001", email: "owner@marina.demo", hash: hash("Marina@123"), demo: null, role: sky.roles.superadmin, rt: null, on: "09:30", off: "18:30", active: 1, pa: 0, sample: 0, at: now - 6 * D });
  db.prepare("INSERT INTO products (id,org_id,name,description,active,sample,created_at) VALUES ('pr_sky_2bhk',?,'2BR Apartments, Dubai Marina','',1,0,?)").run(sky.orgId, now);
  [["James Carter","0561200001"],["Reem Al Shamsi","0561200002"],["Arif Khan","0561200003"]].forEach(([n, m], i) => {
    const cid = "c_sky_" + i, at = now - (i + 1) * D;
    db.prepare("INSERT INTO customers (id,org_id,code,name,mobile,mobile_digits,email,company,created_at) VALUES (?,?,?,?,?,?,'','',?)").run(cid, sky.orgId, "CUS-" + (1001 + i), n, m, m, at);
    lead.run({ id: "l_sky_" + i, org: sky.orgId, code: "LD-" + (2001 + i), name: n, mobile: m, email: "", company: "", pid: "pr_sky_2bhk", src: sky.sources["Meta Ads"], proj: null, ass: "st_sky_owner", st: sky.statuses.new, fu: "", cid, by: "st_sky_owner", at });
  });
  db.prepare("UPDATE leads SET sample=0 WHERE org_id=?").run(sky.orgId);
})();

console.log("Seeded Pulse Shift LMS (SaaS).");
console.log(`Owner + platform admin: ${ownerEmail} / ${ownerPw}${process.env.OWNER_PASSWORD ? "" : "  <- change this after first login"}`);
if (DEMO) {
  console.log("Example customer company: owner@marina.demo / Marina@123");
  console.log("Demo logins are listed on the login page. Remove them with Clear sample data.");
}
