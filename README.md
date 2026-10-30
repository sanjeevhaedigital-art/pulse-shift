# Pulse Shift LMS · Lead Management SaaS

A multi-company Lead Management System by Pulse Shift Media LLC, Dubai. Any business can sign up, get its own private workspace, add its team and manage leads. Pulse Shift Media manages every company from the Platform page.

- **Backend:** Node.js 22.13+ and Express 5
- **Database:** SQLite, one file (better-sqlite3 if installed, otherwise Node's built-in `node:sqlite`)
- **Frontend:** single page in `public/index.html`, served by Express
- **Auth:** bcrypt password hashes, JWT session in an HTTP-only cookie
- **Billing:** plans in AED; managed from the Platform page (online card payments to be connected)

## Run it on your computer

```bash
npm install
cp .env.example .env     # set OWNER_EMAIL and OWNER_PASSWORD
npm start                # creates the database on first run, then serves http://localhost:3000
```

Log in with your owner email and password (default `owner@pulseshiftmedia.com` / `ChangeMe@123`). Change the password with the **Password** button.

`npm run seed -- --reset` wipes everything and starts over.

### If `npm install` shows a better-sqlite3 error

You can ignore it. `better-sqlite3` is optional: if it can't be built on your computer, npm skips it and the app uses the SQLite built into Node.js instead. The startup line tells you which one is in use (`SQLite via node:sqlite` or `SQLite via better-sqlite3`). Both use the same database file.

You need **Node.js 22.13 or newer** (the current LTS from nodejs.org). Check with `node -v`. On Node 20 or older the app stops and asks you to upgrade.

## How the SaaS works

| Who | What they do |
| --- | --- |
| A new business | Sign up → **Start a company**. Gets a workspace, a 14-day Pro trial and becomes its Super Admin. |
| Their staff | Sign up → **Join my team** with the company code, then the Admin approves them. Or the Admin adds them under Staff with a password. |
| Company Super Admin | **Company & Billing**: company code, plan, usage, plan options, payment history. |
| Pulse Shift Media (platform admin) | **Platform**: every company, owner, plan, users, leads, MRR. Change plan, record manual payments, suspend, delete. |

Every company's data is separate. All API queries are filtered by company on the server.

### Plans

Edit prices and limits in `src/plans.js`.

| Plan | Price / month | Active users | New leads / month |
| --- | --- | --- | --- |
| Free trial | Free for 14 days | 15 | 5,000 |
| Starter | Free | 3 | 300 |
| Pro | AED 299 + 5% VAT | 15 | 5,000 |
| Business | AED 799 + 5% VAT | 100 | 50,000 |

When a trial or paid period lapses (with 3 days' grace), the company drops to Starter limits. Nothing is deleted.

## Online billing (UAE)

Razorpay, which this code supports, onboards Indian businesses only, so it's off here. Until a UAE payment provider is connected (Stripe, Telr or Network International), plans are changed by a platform admin on the **Platform** page, which records the payment. Prices are set in `src/plans.js` (AED, excluding 5% VAT).

## Put it live (your own URL)

SQLite stores everything in one file, so the host must give you a **persistent disk**. Free tiers that wipe the disk on restart will lose data.

### Option A: Render (easiest)
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml` (Starter plan with a 1 GB disk, Frankfurt region).
3. Fill `OWNER_EMAIL` and `OWNER_PASSWORD` when asked. Deploy.
4. You get `https://pulse-shift-lms.onrender.com`. Add your own domain (e.g. `lms.pulseshiftmedia.com`) under Settings → Custom Domains.

### Option B: Railway
1. Railway → **New Project → Deploy from GitHub repo**. It builds the `Dockerfile`.
2. Add a **Volume** mounted at `/data` (the Dockerfile stores the database at `/data/pulse-shift-lms.db`).
3. Add the variables from `.env.example`, with `COOKIE_SECURE=true`. Generate a domain under Settings → Networking.

### Option C: Any VPS (Hostinger, DigitalOcean, AWS Lightsail)
```bash
git clone … && cd pulse-shift-lms && npm ci --omit=dev && cp .env.example .env   # edit it
npm i -g pm2 && pm2 start npm --name pulse-shift-lms -- start && pm2 save
```
Put Nginx in front with a free Let's Encrypt certificate, and set `COOKIE_SECURE=true`.

### Before real customers sign up
- Set `SEED_DEMO=false` and `SHOW_DEMO_LOGINS=false` for a clean install, or sign in and click **Clear sample data**.
- Delete the example company **Marina Heights Properties** from the Platform page.
- Back up the database file daily (Render and Railway have disk snapshots; on a VPS copy `data/pulse-shift-lms.db`).

## Project layout

```
src/
  env.js       loads .env, sets the time zone
  db.js        SQLite schema (created on first run)
  plans.js     plan prices and limits
  tenant.js    creates a company with default roles, statuses, sources
  seed.js      first-run data: Pulse Shift Media company, owner, optional demo data
  server.js    API, auth, permissions, billing, platform admin, live updates
public/index.html   the app
Dockerfile, render.yaml, railway.json   deploy configs
```

## Uploading a lead sheet

Leads → **Upload sheet** takes a CSV or Excel file (first row = column labels, up to 2,000 rows). Columns are matched to LMS labels automatically and can be changed before importing:

Name *, Mobile *, Email, Company, Product, Source, Department / Project, Assigned to (email or name), Status, Follow-up date, Remark

- Names in Product, Source, Department, Assigned to and Status must match what's set up in the LMS. Rows that don't match are listed with the reason and left out.
- Defaults fill empty columns. Duplicates (same mobile + product with an open lead) are skipped unless you choose to add them.
- Who can upload is the **Upload lead sheet** rule in Roles & Rules (on for every role by default). Roles without **Assign lead** get the uploaded leads in their own list. Who sees uploaded leads follows each role's **Lead visibility** rule.
- Excel files are read with SheetJS loaded from cdnjs, so the browser needs internet access; CSV works offline.

The Leads table shows the **Latest remark** for each lead (newest remark, status update or message sent, with who wrote it and when).

## Not built yet

- Sending email, SMS and WhatsApp directly. The app fills templates and logs sends; connect SMTP, MSG91 or the WhatsApp Cloud API in `server.js`.
- Automatic lead capture from Meta Lead Ads and website forms. Add a webhook that reuses the `POST /api/leads` logic.
- Password reset by email and VAT invoices. Admins reset passwords from Staff.
- One email in several companies. Each email belongs to one company.
