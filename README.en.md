# Tangtang Kuaipao · Campus Running Mini Program 2.0

**English** | [简体中文](README.md)

> A campus sports tracking and class management platform for universities: a WeChat Mini Program
> (student app + admin console in one package) with a Node.js backend and MongoDB.
> **Current version: v2.0.13** · [GitHub Release](https://github.com/TBDengTa/campus-run/releases/tag/v2.0.13)

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-WeChat%20MiniProgram-07C160">
  <img alt="backend" src="https://img.shields.io/badge/backend-Node.js%20%7C%20Express-339933">
  <img alt="database" src="https://img.shields.io/badge/database-MongoDB-47A248">
  <img alt="ui" src="https://img.shields.io/badge/UI-TDesign-0052D9">
  <img alt="version" src="https://img.shields.io/badge/version-2.0.13-FF6B00">
  <img alt="release" src="https://img.shields.io/github/v/release/TBDengTa/campus-run?label=release&color=FF6B00">
  <img alt="license" src="https://img.shields.io/github/license/TBDengTa/campus-run">
</p>

> This English README mirrors the structure of the Chinese [README.md](README.md). The Chinese
> documentation under `docs/` remains the canonical source; links below point to those files with a
> short English description.

---

## Contents

- [Open Source & Releases](#open-source--releases)
- [Overview](#overview)
- [Core Capabilities](#core-capabilities)
- [Technical Architecture](#technical-architecture)
- [Internal File Architecture](#internal-file-architecture)
- [Quick Start](#quick-start)
- [Permission Model](#permission-model)
- [Key Data Conventions](#key-data-conventions)
- [Deployment Checklist](#deployment-checklist)
- [Quality Assurance](#quality-assurance)
- [Security](#security)
- [Documentation Map](#documentation-map)
- [Version History](#version-history)
- [License](#license)

---

## Open Source & Releases

The project is open source on GitHub: **<https://github.com/TBDengTa/campus-run>**

- Stars, issues, and pull requests are welcome;
- Schools and teams may self-host and extend the project; see the [deployment checklist](#deployment-checklist);
- The Mini Program's “Me → About” page also shows the repository URL (tap to copy);
- **Release history**: <https://github.com/TBDengTa/campus-run/releases>

> **v2.0.13 is the first official GitHub Release of this repository.** It is published as source
> archives only — **no** bundle containing real domains, `.env` files, or database connection strings
> is attached.
> To build a Linux deployment bundle, run `node tools/make-linux-bundle.js` on your own machine.
> **Never** upload an artifact built with `--mongo-uri=` (preset connection string) to a public repository.

**Single source of truth for the version number**: `server/package.json`, `README.md`, and
`miniprogram/pages/about/about.js` must agree. `/health` reads `version` directly from
`server/package.json`; do not hard-code another copy in the client.

> The repository contains **no** real credentials or domains. `server/.env`,
> `miniprogram/config/env.js`, and `deploy/` are all git-ignored. Copy `.env.example` /
> `env.example.js` and fill in your own values; never commit real secrets or server addresses.

---

## Overview

**Tangtang Kuaipao** is built around a “record → goal → incentive → management” loop:

- **Record**: WeRun step sync + GPS run tracks, two data sources in one system;
- **Goal**: global default goals plus plans auto-matched by BMI, gender, and intensity preference;
- **Incentive**: run score, achievement badges, class league (Ban Chao), and Beidou Sports
  (copper-coin economy / lucky wheel / nine-grid);
- **Manage**: the admin console is embedded in the same Mini Program and covers users,
  organizations, classes, the Student Union, appeals, content, ads, and system configuration.

Four groups of users:

| Role | Typical needs | What the system provides |
|---|---|---|
| **Student** | Daily activity, rankings, badges | Step sync, GPS runs, goal plans, leaderboards, badges, Beidou Sports |
| **Teacher / homeroom teacher** | Monitor their class, review appeals | Class ledger, homeroom management, appeal review, permission groups |
| **Student Union** | Inspections, dorm checks, review, member management | Inspection entry, watermark camera, review console, rosters, stats, QR-code join |
| **Administrator** | School-wide data, rosters, content, operations | Dashboards, user / organization / class management, ads and content, Web console |

> **Teacher accounts do not participate in activity records or rankings**: step sync, GPS runs, and
> reward-video step bonuses are blocked at three server-side layers so teacher data cannot pollute
> leaderboards. The teacher “Me” page also hides privacy settings and “My appeals” (teachers are not
> ranked and have no appeal flow).

---

## Core Capabilities

### Student app

| Module | Description |
|---|---|
| WeRun sync | Decrypts WeRun data, stores daily / weekly progress and per-period targets |
| GPS runs | Map track, distance / pace / calories, route history, background location |
| Activity records | Weekly stats, monthly calendar markers, holiday labels, daily / monthly lists |
| Leaderboards | Today / week / all-time × school / department / class, sortable by run score |
| Goal plans | BMI and body data → auto-matched plan; manual selection also supported |
| Achievement badges | Seven condition types (cumulative / single-day / streak, etc.) with tier groups |
| Beidou Sports 3.0 | Check-in, video watching, friend shares earn copper coins; wheel / nine-grid spend coins; server-side pricing, idempotency, and pity rewards |
| Other | Water check-in, reward videos for steps, ban appeals, announcements / changelogs, campus identity binding |

### Teacher / homeroom teacher

| Module | Description |
|---|---|
| My class | Class overview, roster, rankings, attendance, class league, class settings |
| Class status | School-wide class dashboard: attendance + campus-run targets + class-league score, with day / week / month windows |
| Homeroom powers | Edit student profiles, reset passwords, award badges, restrict sync / GPS, assign dorms — no admin permission required |
| Appeal review | Controlled by permission groups; approval lifts the restriction and writes an audit trail |

### Student Union

| Module | Description |
|---|---|
| Inspection entry | Hygiene / evening self-study / dorm check / morning exercise / 8 a.m. attendance, rendered from module fields and target type |
| Watermark camera | Burns “module · target / time / department · inspector” into the photo at capture time |
| Review console | Score bands, inspector / summary / photos, single review and batch review |
| Rosters & stats | Inspection records, absence lists, photo privacy cropping, department-scope stats |
| Members & settings | Member management, departments and duty modules, QR-code join (presidium / ministers) |

### Admin console (Mini Program subpackage, rendered by permission)

| Module | Description |
|---|---|
| Dashboard | Users / activity / steps / ad PV trends |
| User management | Search, multi-dimensional filters (school → department → major cascade), batch actions, password reset, ban / unban, dorm assignment |
| Organization | School → department → major tree; student records are derived from it |
| Class ledger | Class roster, morning exercise / 8 a.m. / evening study / campus-run switches, classrooms, hygiene areas, dorm checks |
| Student Union | Members, departments and duty-module configuration, inspection review |
| Assessment & goals | Default goals, plan goals, run-score settings, anti-cheat |
| Appeals | Appeal list and review (approval lifts the ban) |
| Content & notices | Announcements, holidays, badge definitions, changelogs |
| Ad operations | Sponsors / slots / creatives / hosted H5 landing pages / PV and click stats |
| System settings | Building names, file management, demo accounts, Beidou Sports (coin economy / wheel / nine-grid) |

### Platform capabilities

- **Anti-cheat**: step spikes, abnormal pace, sync growth rate, GPS track features; manual labels →
  model training → staged self-upgrade;
- **Tangtang AI**: unsupervised Isolation Forest + supervised logistic regression; shadow mode caps
  its score and never bans on its own;
- **Web console**: `/console` dashboard and AI training console, password login with HttpOnly Cookie
  sessions, completely isolated from Mini Program JWTs;
- **Glassmorphism UI**: single source of `--tt-glass-*` tokens, light / dark sets, solid fallback via
  `@supports not`;
- **Three-tier responsive layout**: phone single column / iPad two columns / Mac·PC three columns,
  with breakpoints implemented only in `utils/screen.js`;
- **Exports**: class attendance and class-league reports as styled Excel (ExcelJS), with in-app
  preview, download, open, and share fallback;
- **Cache protection**: global `no-store` for `/api/*`, `no-store` for `/health`, `immutable` for
  `/uploads`, gzip only at Nginx.

---

## Technical Architecture

```
┌──────────────────────────────────┐         ┌──────────────────────────────────┐
│ WeChat Mini Program (native+TDesign)│ HTTPS │ Nginx (TLS / gzip / static / proxy)│
│  ┌────────────┬────────────────┐ │ ──────► │              │                   │
│  │ Main package│ packageAdmin   │ │         │              ▼                   │
│  │ student 27p │ admin 33p      │ │         │  Node.js + Express (:3010)        │
│  ├────────────┼────────────────┤ │         │  routes/ (auth + params)          │
│  │packageUnion│ custom-tab-bar │ │         │  services/ (single implementation)│
│  │ union 7p    │ role-aware     │ │         │  models/ (MongoDB / Mongoose)     │
│  └────────────┴────────────────┘ │         │  public/console (Web console)     │
└──────────────────────────────────┘         └──────────────────────────────────┘
```

**Technology choices**

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Native WeChat Mini Program + TDesign | No heavy framework; admin and Student Union live in subpackages |
| Backend | Node.js + Express | Layered: `routes/` (auth + params) → `services/` (single implementation) → `models/` |
| Database | MongoDB + Mongoose | Explicit collection names; indexes on large collections; BSON Date for time |
| Auth | JWT + permissions / permission groups | Server-side `requirePermission`; the client only controls visibility |
| Web console | Plain HTML/CSS/JS | No build chain; strict CSP; Cookie sessions isolated from Mini Program JWTs |
| Deployment | Nginx + systemd + HTTPS | Reverse proxy, static uploads, boot start, graceful shutdown |

**Request lifecycle (Mini Program)**

```
Page onLoad/onShow
  → utils/request.js (BASE_URL, token, timeout, 401 self-heal, ban detection)
  → GET/POST /api/*
  → Express: /api no-store → auth (JWT + openid consistency + ban allow-list)
  → routes/* (auth, params, response only)
  → services/* (single implementation of decisions and writes)
  → models/* (explicit collection names + indexes)
```

**Design principles**

- **One implementation per business rule**: password reset, account deletion, dorm assignment,
  badge awards, inspection review, and score calculation each have exactly one service used by both
  the admin and class / Student Union domains;
- **Reference data separated from maintenance permission**: read-only data used in forms (building
  names, organization tree) is served by dedicated read-only endpoints, so callers do not need
  school-wide configuration permissions;
- **The client controls visibility; the server is the gate**: every write endpoint has
  `requirePermission` or a membership check; `capabilities` from the server decides which buttons
  the client renders;
- **Judgment ≠ enforcement**: anti-cheat “label / train” and “ban / archive” are orthogonal; both
  the UI and the APIs expose them as separate groups.

For the detailed layering, module map, and extension guide, see
**[docs/architecture.md](docs/architecture.md)** (Chinese).

---

## Internal File Architecture

```
.
├── project.config.json            # WeChat DevTools config (miniprogramRoot → miniprogram/)
├── README.md                      # Chinese README: product / architecture / setup / release
├── README.en.md                   # This English README
├── AGENTS.md                      # Repository conventions and hard constraints
├── LICENSE
│
├── miniprogram/                   # Mini Program frontend (main package + 2 subpackages, 67 pages)
│   ├── app.js / app.json / app.wxss
│   ├── pages/                     # Student main package: 27 pages
│   ├── packageAdmin/              # Admin subpackage: 33 pages (permission-rendered)
│   ├── packageUnion/              # Student Union subpackage: 7 pages (entry / camera / review / rosters)
│   ├── components/                # 8 shared components (attendance, dorm, person picker, ads, etc.)
│   ├── behaviors/                 # screen (three-tier breakpoints) / skyline (renderer adaptation)
│   ├── custom-tab-bar/            # Custom glass floating tab bar (role-aware)
│   ├── utils/                     # 15 utilities: request / nav-groups / screen / watermark / format, etc.
│   ├── assets/                    # Icons and home images (kept around 200KB)
│   ├── config/env.example.js      # Environment template (copy to env.js; not committed)
│   └── miniprogram_npm/           # Prebuilt tdesign-miniprogram
│
├── server/                        # Node.js backend
│   ├── src/
│   │   ├── app.js                 # createApp: middleware, static files, /api mounts, error handling
│   │   ├── index.js               # Startup: DB connect, bootstrap seeds/migrations, listen, graceful exit
│   │   ├── config/                # Environment variables and defaults
│   │   ├── middlewares/           # auth (JWT) / admin (permissions) / error
│   │   ├── routes/                # 18 student / class / Student Union routes
│   │   ├── routes/admin/          # 16 admin routes (each with requirePermission)
│   │   ├── services/              # 48 business services (single implementations)
│   │   ├── models/                # 47 Mongoose models (explicit collection names)
│   │   └── utils/                 # Response, upload, date helpers
│   ├── public/console/            # Web console static page (no build chain)
│   ├── public/beidou/             # Built-in Beidou symbols (coin / crown / star)
│   ├── scripts/                   # 11 migration / backfill / bootstrap scripts (dry-run by default)
│   ├── .env.example               # Environment template (real .env not committed)
│   └── uploads/                   # Runtime uploads (not committed)
│
├── docs/                          # Design / database / API / deployment / incident notes
├── tools/                         # 41 check-* + 19 verify-* + generators
├── deploy/                        # Local deployment scripts and site config (real domains; ignored)
└── dist/                          # Local build artifacts (ignored)
```

**Where to make common changes**

| Need | Look here first | Notes |
|---|---|---|
| Add a page | `miniprogram/app.json` + `pages/` or a subpackage | The main package is close to 2MB; new admin / union pages go to subpackages |
| Add an API | `server/src/routes/` → `services/` → `models/` | Routes only auth and parse params; business logic goes in a service |
| Add a permission | `models/permission.js::DEFAULT_CATALOG` + `routes/admin/index.js` | Add the permission item, mount the route, then add `canManage` on the client |
| Change navigation / workbench | `miniprogram/utils/nav-groups.js` | Single source shared by home and workbench; do not duplicate the context |
| Change building / room labels | `server/src/services/dorms.js` + `miniprogram/utils/room-label.js` | Both sides must match rule by rule |
| Change name search | `server/src/services/name-search.js` | Shared by seven entry points; never hand-roll a name regex |
| Change organization attribution | `server/src/services/org-resolve.js` | ID first, name fallback, fail closed on ambiguity |
| Change class status / class league | `services/class-status-board.js` / `band-chao.js` | Dashboard and class league must share the same source |
| Change Beidou economy | `services/beidou*.js` + `docs/beidou-economy-plan.md` | Pricing, idempotency, pity, and ledger all live on the server |
| Change anti-cheat | `services/anticheat*.js` + `docs/edgeone-traffic.md` | Judgment ≠ enforcement; automatic handling has a master switch |
| Extend the watermark camera | `miniprogram/utils/watermark.js` + `packageUnion/wcamera` | Copy and layout have one source; compositing happens on the client |

---

## Quick Start

### Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 18 |
| MongoDB | ≥ 5.0 |
| WeChat DevTools | Latest stable |
| Mini Program base library | ≥ 2.30.0 (custom tabBar + TDesign 3.x) |

### Backend

```bash
cd server
cp .env.example .env        # fill in MONGO_URI / JWT_SECRET / WX_APPID / WX_APPSECRET
npm install
npm run dev                 # node --watch, default :3010
```

Required environment variables:

```ini
PORT=3010
HOST=127.0.0.1
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=campus_run
JWT_SECRET=<openssl rand -hex 48>
WX_APPID=<Mini Program appid>
WX_APPSECRET=<Mini Program secret; required for cloud hosting / Docker>
```

> `DEV_LOGIN=true` enables local test accounts (`dev-student` / `dev-teacher` / `dev-admin`).
> **Turn it off in production.** The first startup seeds permission catalogs, built-in permission
> groups, ad slots, badges, inspection modules, and global configuration; all seeds are idempotent.

### Mini Program

1. Open the repository root in WeChat DevTools;
2. Copy `miniprogram/config/env.example.js` to `env.js` and set the backend URL;
3. Without an AppSecret, set `DEV_LOGIN: true` in `env.js` and use `DEV_ROLE` to switch among the
   three test roles (the backend must enable it too);
4. Details → Local Settings → check “Do not verify valid domains” (development only);
5. Compile and run.

### Pre-commit checks

```bash
# All static checks (no database required)
node tools/check-miniprogram.js
node tools/check-server-contract.js
node tools/check-nav-groups.js
node tools/check-glass-ui.js

# Or run all at once (PowerShell)
Get-ChildItem tools -Filter 'check-*.js' | ForEach-Object { node $_.FullName }

# End-to-end checks (need a reachable database; scripts create and clean up temporary data —
# never run them against production)
node tools/verify-identity-e2e.js
node tools/verify-teacher-rebind.js
node tools/verify-class-status.js
```

### Troubleshooting

| Symptom | Check first |
|---|---|
| `requires authentication` at startup | Whether `MONGO_URI` includes credentials / correct `authSource` |
| `ECONNREFUSED` at startup | Whether mongod is running, the port, cloud database allow-list |
| All Mini Program requests fail | Whether `miniprogram/config/env.js` exists, `BASE_URL`, valid domains |
| Uploads / images return 502 | Nginx `client_max_body_size`, `/uploads` alias path |
| Changes “don't take effect” online | `/health` `build` / `version`, console `?v=`, EO / CDN cache mode |
| Main package exceeds 2MB | Whether a page was added to the main package; `check-miniprogram` reports main and subpackage sizes separately |

---

## Permission Model

**There are only two roles: student and teacher. “Administrator” is a permission combination, not a
separate role.**

- **Permission**: a fine-grained capability such as `user.view` / `user.manage` /
  `content.manage` / `config.manage`;
- **Permission group**: a named set of permissions granted as a whole; built-ins include the
  “super admin” group (`*`, all permissions) and the “teacher admin” group;
- **Effective permissions** = directly held permissions ∪ permissions expanded from the user's groups;
  `*` is a wildcard.

Four rules:

1. **Every admin route is mounted with `requirePermission`**; hiding UI is not access control;
2. **Add a permission item first** (`Permission.DEFAULT_CATALOG`, seeded at startup), then mount the route;
3. **Built-in groups are editable but not deletable**; an edited group gets `customized: true`, so
   restarts no longer overwrite it with defaults. The super-admin group is the exception — always
   read-only, to avoid locking everyone out;
4. **Read-only accounts never see write actions**: each page computes `canManage` with a shared
   helper and renders write buttons from it; the server still validates every write.

Three additional **non-permission** authorization sources:

- **Homeroom teacher**: if `user.homeroomClasses` contains the target class, the teacher can manage
  that class (edit profiles / reset passwords / award badges / restrict sync·GPS / assign dorms)
  **without any admin permission**. The allowed actions are sent as `capabilities`; account deletion
  is a school-level action and is not granted by default.
- **Class committee**: `user.isClassOfficer`, read-only access to their own class.
- **Student Union**: membership + department + school/department scope, plus module-level
  `union.manage` for writes.

Both class identities are enforced by **membership checks** (not `requirePermission`) under
`/api/class/*`.

---

## Key Data Conventions

These conventions are implemented on both server and client. Read the relevant `AGENTS.md` section
before changing them:

| Convention | Single implementation | Key point |
|---|---|---|
| Grade | `services/roster.js::gradeFromStudentId()` | First 4 digits of the student ID (1900–2099), displayed as “Class of 2023” |
| Class name | `services/roster.js::classNameFromGradeSpecialty()` | Last two grade digits + major; finer class names keep their section number |
| Organization attribution | `services/org-resolve.js` | If `departmentId` exists, trust only the ID; name fallback requires a unique match, otherwise fail closed |
| Building · room | `services/dorms.js::parseRoomLabel` + `utils/room-label.js` | Longest whitelist building prefix first; room numbers normalized and idempotent |
| Room ownership | `services/dorms.js::roomLiveOwners()` | Derived from current residents, never from a snapshot taken when the room was created |
| Name search | `services/name-search.js::keywordOr` | Homophone / mispronunciation search enabled for ≥2 Chinese characters; shared by seven entry points |
| Inspection scoring | `services/check-modules.js` + `score-scale.js` | 10-point scale; historical 100-point records converted by migration |
| Class league / class status | `services/band-chao.js` / `class-status-board.js` | Same window, same score, same deduction details |
| Anti-cheat sync rate | `steps.js` + `check-sync-rate` | Intervals < 180s are not judged; score capped below the auto-ban line |
| Time / date | `utils/format.js` / server BSON Date | Displayed in Asia/Shanghai; calendar keys are `YYYY-MM-DD` strings |

For collection names, indexes, and fields, see [docs/database-v2.md](docs/database-v2.md) (Chinese).

---

## Deployment Checklist

| Item | Notes |
|---|---|
| HTTPS domain | Deploy the backend on a valid domain and add it to the Mini Program **request valid domains** |
| Business domain | The ad landing page (`/p/:slug`) domain must be added as a **business domain** (web-view) |
| Icon font | TDesign icons use a CDN (`tdesign.gtimg.com`); add it to **downloadFile valid domains** |
| WeChat AppSecret | `WX_APPSECRET` in the backend `.env` (required for code2session / WeRun decryption) |
| WeRun | The Mini Program needs the “WeChat Sports” category permission |
| Ad traffic | Replace the rewarded-video ad unit ID in `miniprogram/pages/reward/reward.js` |
| Administrator | ① `ADMIN_BOOTSTRAP_OPENIDS` in `.env` (auto-grant super admin on login); ② `npm run admin:add -- <openid>`; ③ “User detail → Permissions” in the admin console |
| JWT_SECRET | Use a long random string (`openssl rand -hex 48`) |
| DEV_LOGIN | Confirm it is **false** in both `server/.env` and `miniprogram/config/env.js` |
| Version | `server/package.json` / `README.md` / `miniprogram/pages/about/about.js` must agree |
| Cache | EO / CDN must follow the origin; `/api/*` and `/health` must not be cached |
| Bundle | `node tools/make-linux-bundle.js` (without `--mongo-uri=`), artifact stays in local `dist/` |
| Backup | Data-fix scripts dry-run by default; back up before `--apply`; scripts write a backup to `_backup/` before touching the database |

> **Release safety red line**: `deploy/` contains real domains and site configuration, and `dist/`
> may contain a preset database connection string. Both are ignored and **must never** be uploaded
> as GitHub Release assets. Public releases contain source archives only.

---

## Quality Assurance

The repository ships **41 static checkers + 19 end-to-end verification scripts**, each covering a
real incident from the project's history. The philosophy is simple: **if a rule can be checked
statically, do not rely on manual review**.

| Checker | Rule it protects |
|---|---|
| `check-miniprogram` | WXML / WXSS / JS syntax, event bindings, icons, classes, page files, main / subpackage size |
| `check-server-contract` | Single implementation, 429 / permission contracts, score and deduction conventions, reference data vs. maintenance paths |
| `check-write-guard` | Every admin write entry has a permission guard (tag-stack parsing, not indentation guessing) |
| `check-nav-groups` | Role navigation matrix, single workbench tab slot, entries gated by real capability |
| `check-glass-ui` | Single source of glass tokens, blur spec, fallback chain, no rpx in wide layouts, tabBar mounting contract |
| `check-dark-mode` | Dark token coverage, token-driven tabBar, mounting contract assertions |
| `check-room-label` | Building / room parsing matches on both sides, hyphenated building names are not split, dirty room numbers are idempotent |
| `check-org-resolve` | Single organization resolver, ID first, facet count conservation |
| `check-name-search` | Homophone / mispronunciation rules, ≥2 characters, search concurrency and debounce |
| `check-union-review` | Band boundaries, single implementation, queue scope, cropping, client wiring |
| `check-watermark-camera` | Optimistic preview, quality-step retry, fallback to the original, dual entry points |
| `check-traffic-headers` | `/api` no-store, `/health` no-store, `/uploads` immutable, gzip only at Nginx |
| `check-anticheat-*` | Automatic-handling master switch, ban source classification, staged upgrade gates and demotion |
| `check-beidou-*` / `check-banchao-report` | Copper-coin economy, nine-grid lines, payout ratio, report aggregation and export |

End-to-end scripts connect to a real database, create temporary data, and clean it up afterwards.
**Do not run them against production.**

```bash
# Static checks
Get-ChildItem tools -Filter 'check-*.js' | ForEach-Object { node $_.FullName }

# End-to-end examples
node tools/verify-console.js
node tools/verify-class-status.js
node tools/verify-class-export.js
node tools/verify-union-review.js
node tools/verify-anticheat-upgrade.js
node tools/verify-beidou-lottery.js
```

---

## Security

- The repository contains **no** server addresses, database credentials, or keys: backend config
  lives in `server/.env`, frontend config in `miniprogram/config/env.js`, and `deploy/` / `dist/`
  are ignored;
- **Credential fields never reach the client**: `models/user.js::toSafeJSON()` strips
  `passwordHash` / `initialHashes` / `resetHashes`; every new “user document → client” path must use
  it or an explicit allow-list;
- Admin permissions are validated again on the server (JWT + permission items); hiding UI is only
  the first gate;
- Mini Program identity = **the account tied to the current token**; the JWT is strongly bound to
  the WeChat account at issue time, so unbinding or rebinding invalidates old tokens immediately;
- One-tap login tokens are 32 random bytes, stored only as SHA-256, valid for 30 days, and rotated
  after use;
- The Web console's Cookie session and the Mini Program JWT are **fully isolated**; CSP is strict
  (`script-src/style-src 'self'`), inline `style=` / `onclick` are forbidden, and client rendering
  uses `textContent`;
- Inspection photos are cropped by role (inspector / presidium / department minister / teacher);
  everyone else **does not receive the original URL**;
- Release assets contain source archives only — **never** a bundle with real domains, `.env`, or
  database connection strings.

---

## Documentation Map

| Document | Content |
|---|---|
| **[docs/architecture.md](docs/architecture.md)** | **Internal file architecture: layering, module map, data flows, extension guide, release process** |
| [docs/database-v2.md](docs/database-v2.md) | Database 2.0 design (collections, indexes, field conventions) |
| [docs/api.md](docs/api.md) | API reference (student / class / Student Union / admin) |
| [docs/ui-design.md](docs/ui-design.md) | White-orange design system, glassmorphism, three-tier responsive rules |
| [docs/migration.md](docs/migration.md) | 1.0 → 2.0 data migration guide |
| [docs/edgeone-traffic.md](docs/edgeone-traffic.md) | EO / CDN traffic investigation and cache protection |
| [docs/watermark-camera-plan.md](docs/watermark-camera-plan.md) | Watermark camera conventions and boundaries (D1–D10) |
| [docs/watermark-camera-round2-plan.md](docs/watermark-camera-round2-plan.md) | Output-size budget and landscape UI |
| [docs/student-union-plan.md](docs/student-union-plan.md) | Class league + Student Union plan and acceptance criteria |
| [docs/beidou-economy-plan.md](docs/beidou-economy-plan.md) | Beidou Sports 3.0: copper-coin economy / nine-grid / friend-click attribution |
| [docs/beidou-lottery-plan.md](docs/beidou-lottery-plan.md) | Beidou Sports 2.0 (historical; 3.0 wins on conflicts) |
| [docs/beidou-lottery-ui-plan.md](docs/beidou-lottery-ui-plan.md) | Lottery page compact layout / announcements / motion / sound |
| [docs/class-org-scope-diagnosis.md](docs/class-org-scope-diagnosis.md) | Class department attribution / “no classes” filter diagnosis |
| [docs/round2-tasks.md](docs/round2-tasks.md) | Class league / Student Union round-two task book (decision record) |
| [docs/union-ui-b-round.md](docs/union-ui-b-round.md) | Student Union B-side UI task book |
| [AGENTS.md](AGENTS.md) | Repository conventions and hard constraints |

> Most documents are written in Chinese; this English README is the English entry point.

---

## Version History

| Version | Date | Highlights |
|---|---|---|
| **v2.0.13** | 2026-11-25 | **First official GitHub Release.** Rolls up capabilities since 2.0.7: Beidou Sports 3.0 copper-coin economy (check-in / video / friend shares / wheel / nine-grid / pity / ledger, all legacy APIs kept) + class status and class league sharing one source (10-point scale, day / week / month windows, deduction details, summary + per-class Excel export) + class reports and class-league reports (server aggregation + canvas / Excel) + glassmorphism navigation and three-tier responsive layout (phone single column / iPad two columns / PC three columns) + inspection watermark camera (output-size loop, landscape layout, optimistic preview) + Tangtang AI staged self-upgrade (shadow assist / primary decision, auto-demotion, manual lock) + Web console and independent anti-cheat permission groups + unique building/room parsing and live room ownership + Student Union member filters that truly query the database + cache protection and removal of upload limits. |
| **v2.0.12** | 2026-11 | My Class / Class Status UI refactor and export: campus-run date lookback, compact class-league layout, class attendance grouped by selected range, deduction `targets`, weekly / monthly attendance CSV. |
| **v2.0.11** | 2026-11 | Class status and class league share “one window + one score”; inspection record filters and cards; no repeat ban after unban; three-layer fix for “records not shown” in class attendance. |
| **v2.0.9** | 2026-11 | Single building/room parsing convention; live room ownership from current residents; Student Union member list actually filtered in the database; two sample-count conventions; single organization resolver and watermark camera. |
| **v2.0.7** | 2026-11 | Tangtang AI staged self-upgrade: three stages, supervised logistic regression, quantitative gates, shadow score cap, auto-demotion, manual lock, matching stage cards on both clients. |
| **v2.0.6** | 2026-11 | Beidou Sports 2.0 (check-in + wheel for steps + video / share for draws); EO cache protection; dark mode completion. |
| **v2.0.5** | 2026-10 | Independent anti-cheat permission groups and Web console; ban source classification; school-wide class status dashboard; “sync growth rate” false-ban fix. |
| **v2.0.4** | 2026-10 | Tangtang AI data model: Isolation Forest, separate WeRun / GPS models, physical constraint layer, human feedback; step anomaly management page. |
| **v2.0.0** | 2026-10 | Full rewrite: frontend/backend split, embedded admin console, white-orange design system, custom floating navigation, class domain, class league, Student Union, run score, package split, static contract checks and end-to-end verification. |

> The 1.0 code has been lost. 2.0 was reverse-engineered from the old MongoDB schema, with new
> collections and a one-time migration plan documented in the migration guide.
> For the detailed release process (version bump, checks, tagging, Release, deployment bundle), see
> [docs/architecture.md](docs/architecture.md) (Chinese).

---

## License

[MIT License](LICENSE) © 2026 Hebei Tangbo Technology Co., Ltd.

Free to use, modify, and distribute with attribution. Before commercial use, confirm compliance with
your school's data and privacy policies.

---

<p align="center">
  Designed and developed by <b>Hebei Tangbo Technology Co., Ltd.</b><br>
  <sub>Campus sports tracking and management platform · v2.0.13</sub>
</p>
