// Creates a company workspace with its default roles, statuses and sources
const crypto = require("crypto");
const db = require("./db");
const { PLANS } = require("./plans");

const PERMS = ["createLead","uploadLeads","assignLead","assignProduct","updateLead","reassignLead","viewLead","assignStatus","oldProjects","dashboard","sendAlert","manageStaff","manageMasters"];
const perms = (...on) => JSON.stringify(Object.fromEntries(PERMS.map(k => [k, on.includes(k)])));
const uid = () => crypto.randomUUID();

const DEFAULT_ROLES = [
  ["superadmin", "Super Admin", "all", PERMS, 1],
  ["admin", "Admin", "all", PERMS, 0],
  ["manager", "Manager", "hierarchy", ["createLead","uploadLeads","assignLead","assignProduct","updateLead","reassignLead","viewLead","assignStatus","oldProjects","dashboard","sendAlert"], 0],
  ["tl", "Team Leader", "team", ["createLead","uploadLeads","assignLead","assignProduct","updateLead","reassignLead","viewLead","assignStatus","oldProjects","dashboard","sendAlert"], 0],
  ["coordinator", "Lead Coordinator", "routed", ["createLead","uploadLeads","assignLead","assignProduct","updateLead","reassignLead","viewLead","assignStatus","oldProjects","dashboard"], 0],
  ["telecaller", "Telecaller", "own", ["createLead","uploadLeads","updateLead","viewLead","assignStatus","dashboard"], 0],
  ["accounts", "Accounts", "converted", ["uploadLeads","updateLead","viewLead","assignStatus","oldProjects","dashboard"], 0],
];
const DEFAULT_STATUSES = [["new","New","new"],["cont","Contacted","open"],["int","Interested","open"],["fu","Follow-up","followup"],["prop","Proposal Sent","followup"],["quote","Quotation Sent","followup"],["conv","Converted","converted"],["ni","Not Interested","dead"],["inv","Invalid Number","dead"]];
const DEFAULT_SOURCES = ["Manual","Website","Google Ads","Meta Ads","Instagram","LinkedIn","WhatsApp","Referral","Landing Page"];

function makeCode(name) {
  const base = (String(name).replace(/[^A-Za-z]/g, "").slice(0, 4) || "ORG").toUpperCase();
  for (let i = 0; i < 20; i++) {
    const code = `${base}-${crypto.randomBytes(3).toString("hex").slice(0, 4).toUpperCase()}`;
    if (!db.prepare("SELECT 1 FROM orgs WHERE code=?").get(code)) return code;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

/** Returns { orgId, code, roles: {level: id}, statuses: {key: id}, sources: {name: id} } */
function createOrg(name, { id = uid(), plan = "trial", now = Date.now(), code } = {}) {
  code = code || makeCode(name);
  db.prepare("INSERT INTO orgs (id,name,code,plan,status,trial_ends_at,created_at) VALUES (?,?,?,?, 'active', ?, ?)")
    .run(id, name, code, plan, plan === "trial" ? now + PLANS.trial.days * 24 * 3600e3 : null, now);
  const roles = {}, statuses = {}, sources = {};
  const ri = db.prepare("INSERT INTO roles (id,org_id,name,level,scope,perms,sort,system) VALUES (?,?,?,?,?,?,?,?)");
  DEFAULT_ROLES.forEach(([lvl, n, scope, p, sys], i) => { roles[lvl] = uid(); ri.run(roles[lvl], id, n, lvl, scope, perms(...p), i, sys); });
  const si = db.prepare("INSERT INTO statuses (id,org_id,name,cat,sort,active) VALUES (?,?,?,?,?,1)");
  DEFAULT_STATUSES.forEach(([k, n, c], i) => { statuses[k] = uid(); si.run(statuses[k], id, n, c, i + 1); });
  const so = db.prepare("INSERT INTO sources (id,org_id,name,industry,active,built_in) VALUES (?,?,?,'',1,1)");
  DEFAULT_SOURCES.forEach(n => { sources[n] = uid(); so.run(sources[n], id, n); });
  // one starter product so the first lead can be added straight away (rename it under Status, Source & Product)
  db.prepare("INSERT INTO products (id,org_id,name,description,active,created_at) VALUES (?,?,?,?,1,?)").run(uid(), id, "General enquiry", "Rename or add your own products", now);
  return { orgId: id, code, roles, statuses, sources };
}

module.exports = { createOrg, PERMS };
