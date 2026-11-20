# CDS Pass — Complete Handover Document

> **For any developer or AI reading this:** this file describes the whole CDS Pass application — what it does,
> how it is built, how data flows, every API action, how to run and deploy it, known issues — and then contains
> **the full source code of every file**. Read sections 1–9 first; section 10 is the code.
> Project owner: Daniel Success (Derik / DerikWebX). Local path on the owner's PC: `C:\Projects\cds-pass` (Windows).

---

## 0. CURRENT STATE (read this first — updated 17 Nov 2026)

Some later sections were written before these changes; where they disagree, **this section wins**.

| Thing | Now |
|---|---|
| Live website | **https://cdspass.name.ng** (cPanel). Build `npm --prefix web run build`, upload `web/dist` (has `.htaccess` SPA rewrite). Not Firebase Hosting. |
| API server | **https://cds-pass.onrender.com** (Render free tier, `render.yaml`) |
| Firebase project | **`cds-pass`** — Auth + Firestore + Cloud Messaging only. **Firebase Storage is NOT used.** |
| Web config | Hard-coded public values in `web/src/lib/appConfig.ts` (Firebase config, API URL, VAPID key, fee %, platform admin state code). `npm run dev` + `VITE_USE_EMULATORS=true` in `web/.env` → emulators + `http://localhost:8787`; a build always uses live values. |
| Profile photos | **Cloudinary**, via `POST /upload/avatar` (multipart, Bearer token) in `server/src/upload.ts`; public_id = uid. Env: `CLOUDINARY_CLOUD_NAME/_API_KEY/_API_SECRET`. |
| Activity log | **MongoDB Atlas** collection `activity_logs` (`server/src/mongo.ts`, env `MONGODB_URI`, `MONGODB_DATABASE`), falls back to Firestore `groups/{gid}/logs`. Read via API action `getLogs`. |
| Dues charges | member pays dues + 3% service + Paystack's exact charge (`duesCharges` in `server/src/shared.ts` and `web/src/lib/money.ts`). |
| Who creates groups | **Platform admin** (env `PLATFORM_ADMIN_STATE_CODE`, currently `LA/26B/2578`). First time: admin signs up and chooses "Start my CDS group" (`registerPlatformAdmin`). Later: Exco → Settings → `createManagedGroup` names a **main exco** by state code (reservation in `mainExcoReservations/{statecode}`); that person signs up with the join code and is auto-approved as main exco. `createGroup` is retired. |
| Main exco | `groups.mainExcoUid` (fallback `createdBy`). Only the main exco can `setRole`, `createDues`, `testNotification`. |
| Queue counters | moved out of the session doc into `groups/{gid}/private/session-{date}` `{nextNumber, nextPriority}`. |
| Extra pushes | meeting opened/ended, dues created/closed, dues account changed, venue changed, approved, role changed, PIN reset, new member waiting (to excos). FCM data includes `kind`. |
| Sign-up flow | `Signup.tsx`: account → photo upload → register → waits until the profile (and exco claims) reach the phone before leaving. If anything fails after the login is created, the form keeps the typed data and continues from there. Server is pinged (`wakeServer`) when sign-up/login opens. `App.tsx` shows a retry screen instead of an endless spinner if permissions don't load. |
| Render env vars | `FIREBASE_SERVICE_ACCOUNT`, `CORS_ORIGINS=https://cdspass.name.ng`, `PAYSTACK_SECRET_KEY`, `MONGODB_URI`, `MONGODB_DATABASE`, `CLOUDINARY_*`, `PLATFORM_ADMIN_STATE_CODE`, `SERVICE_FEE_PERCENT`, `PAYSTACK_FEE_PERCENT`. |
| Dues gate (20 Nov) | Dues have `dueDate` (collection date) and `requiredForCheckIn`. `assertDuesPaid` inside `admit()` blocks check-in from that date until paid; error text starts "Dues not paid" (ScanIn shows a red pay screen). `recordCash` now counts immediately (status paid); member can dispute via `respondCash({confirm:false})` → status `disputed`, main exco notified. Automatic reminders: `GET /cron/reminders?key=CRON_SECRET` (cron-job.org 07:00 + 18:00 Lagos) → `runDuesReminders()`, once per dues per slot (`remindersSent`). |
| Main exco tools (20 Nov) | `giveNextNumber` (search member, give next number; increments `session.doorEpoch`, door screen refetches; door code HMAC includes epoch). Typed state code at the door = main exco only; printed card = any exco. `sendGroupMessage` / `listGroupMessages`: custom push to all / unpaid / pending / excos, max 5 per day per group, history in `groups/{gid}/messages`. Pages: `exco/GiveNumber.tsx`, `exco/Messages.tsx`. |
| Admin mode (20 Nov) | Owner = `PLATFORM_ADMIN_STATE_CODE`; team in server-only doc `platform/config.team` {stateCode: 'admin'|'viewer'}. Flags in `platform/config`: signupsPaused, paymentsPaused, maintenance (main.ts `maintenanceGate` returns 503 for non-team), banner. Group pause = `groups.paused` (blocks check-in, meetings, payments). APIs: appStatus (public), adminWhoAmI, adminOverview (5-min cache; users + payments + count() of attendees for last 30 days), adminGetConfig, adminSetConfig, adminSetGroupPaused, adminBroadcast, adminSetTeamMember (owner). Web: `pages/admin/Admin.tsx` (lazy, route /admin), `pages/admin/Charts.tsx` (SVG charts, no library), `components/PlatformChrome.tsx` (gold mode switch User/Exco/Admin, banner, maintenance screen), `hooks/usePlatform.ts`. |
| Deploy rules | `firebase deploy --only firestore:rules` (firebase.json has no hosting/storage any more). |

---

## 1. What the app does

CDS Pass is a **web app (installable PWA)** for Nigerian NYSC **CDS (Community Development Service) groups**.
It fixes two real problems:

1. **The attendance queue.** Today corps members queue early to collect a paper number, then wait until the
   end of the meeting to thumbprint on the LGI's (Local Government Inspector's) official NYSC scanner. Numbers
   get skipped, people jump the line, excos play favourites.
2. **Dues.** Cash dues are collected by hand with no receipts and no transparency.

What CDS Pass does:
- Members **scan a QR code at the door** (or type a 6-digit code). The server gives each person the **next number
  in arrival order**. Numbers can't be bought, swapped or faked.
- Pregnant / nursing mothers get a **priority tag** (P1, P2 …) from an exco; priority is called first.
- Excos **call batches** ("Priority", then 1–20, 21–40 …). Members' phones buzz (FCM push + in-app).
- At the thumbprint table the exco **scans the member's tag**: **green** = their turn (exco checks the NYSC ID card
  against the photo on screen, the LGI thumbprints on the official device, exco taps **Done**), **red** = not your
  turn / already thumbprinted / not checked in. The official NYSC thumbprint is unchanged — CDS Pass only manages
  the queue around it.
- **Dues:** members pay online through **Paystack** (dues + 3% service fee for the developer + Paystack's exact charge (1.5% of the total, +₦100 when the total is ₦2,500 or more, capped at ₦2,000), split automatically: dues → the CDS
  group's bank account via a Paystack subaccount, the 4.5% → the developer's main Paystack account, which bears Paystack's charge). Or the treasurer
  records **cash**, which only counts after the member **confirms** it on their phone.
- Everything an exco does is written to an **activity log** nobody can edit.

It is an **independent tool**, not affiliated with NYSC (no NYSC logo may be used).

### Roles
- **Member** (corps member): sign up, wait for approval, scan in, see tag/number, get batch alerts, pay dues, share tag image.
- **Exco** (CDS executive): everything a member can do + open/close meeting, door code, assisted check-in,
  priority tags, call batches, table check, approve members, make excos, reset PINs, dues admin, settings, print QR cards.
- A group is created by its first exco during sign-up ("I'm an exco"); members join with the group's 6-character **join code**.

### Login
**State code + 6-digit PIN.** Firebase Auth needs an email, so the state code is turned into a hidden email:
`LA/26B/1142` → `la26b1142@cdspass.app`, and the PIN is the password. Members never see the email.
State code format: `^[A-Z]{2}/\d{2}[A-C]/\d{4,5}$` (normalised from lowercase, spaces, dashes or no slashes).

---

## 2. Architecture

| Part | Tech | Hosted on | Folder |
|---|---|---|---|
| Website / PWA | React 18 + Vite 5 + TypeScript, Tailwind 3, Framer Motion 11, React Three Fiber 8 (3D), react-router 6 | Firebase Hosting | `web/` |
| API server | Node 20 + Express 4 + TypeScript, firebase-admin 12 | **Render** (free tier) | `server/` |
| Database | Cloud Firestore | Firebase | `firestore.rules` |
| Login | Firebase Authentication (email/password) | Firebase | — |
| Profile photos | Firebase Storage (`avatars/{uid}/…`) | Firebase | `storage.rules` |
| Push notifications | Firebase Cloud Messaging (web push, VAPID) | Firebase | `web/public/firebase-messaging-sw.js` |
| Payments | Paystack (transactions, subaccounts, webhook) | Paystack | `server/src/handlers.ts` |

**Key principle:** the browser **reads** Firestore directly (live `onSnapshot` listeners) but **never writes**
anything important. Every write that matters (numbers, turns, approvals, dues status) goes through the **API server**,
which uses the Admin SDK and enforces the rules. Firestore security rules block all client writes except a member
editing their own `phone`, `photoURL`, `fcmTokens`, `updatedAt`.

**Request flow:** web `callable(name)(data)` → `POST {VITE_API_URL}/api/<name>` with body `{ data }` and header
`Authorization: Bearer <Firebase ID token>` → server verifies the token (`verifyIdToken`, custom claims included)
→ runs the handler → `{ result }` or `{ error: { status, message } }` (HTTP status mapped from the error code).
The web turns errors into `{ code: 'functions/<status>', message }` so `errorText()` shows a friendly sentence.

**Custom claims** (set by the server on the Firebase user): `{ gid, role: 'member'|'exco', approved: boolean }`.
Firestore rules use them (`request.auth.token.gid` etc.). After approval/role change the web calls
`getIdTokenResult(true)` to refresh them (see `useAuth.tsx`).

**History:** the server code was first written as Firebase Cloud Functions (`onCall`). It was moved to Express on
Render. `server/src/compat.ts` provides tiny stand-ins for `onCall`, `onRequest`, `HttpsError`, `defineSecret`,
`setGlobalOptions`, so `handlers.ts` keeps the Cloud Functions style. Each exported `onCall(...)` in `handlers.ts`
becomes `POST /api/<exportName>` automatically (see `main.ts`). The old `functions/` folder is no longer used.

---

## 3. Folder map

```
cds-pass/
├── firebase.json            Hosting (web/dist, SPA rewrite, predeploy build), Firestore/Storage rules, emulators (auth 9099, firestore 8080, storage 9199, ui 4000)
├── firestore.rules          Security rules (claims-based)
├── firestore.indexes.json   (empty; no composite indexes needed)
├── storage.rules            avatars/{uid}/{file}: owner write, <2 MB, image/*
├── cors.json                Storage CORS (for drawing photos into shared tag images)
├── render.yaml              Render blueprint for the API server
├── README.md                Setup / run / deploy guide
├── server/
│   ├── package.json         dev: tsx watch --env-file=dev.env; dev:keys adds keys.env; build: tsc; start: node dist/main.js
│   ├── dev.env              Local settings (emulator hosts, port 8787, CORS, fee). No secrets.
│   ├── keys.env             (user-created, git-ignored) PAYSTACK_SECRET_KEY=sk_test_...
│   └── src/
│       ├── main.ts          Express app: /health, /paystack/webhook (raw body), /api/:name
│       ├── handlers.ts      ALL business logic: accounts, CDS day, table, dues, Paystack
│       ├── compat.ts        Cloud-Functions-style helpers for Express
│       ├── admin.ts         firebase-admin init (service account on Render, emulators locally)
│       └── shared.ts        State code / phone normalisation, Lagos date, isTurn(), distance
└── web/
    ├── index.html           Fonts, manifest, theme script (dark mode before paint)
    ├── .env                 (user-created) Firebase web config, VAPID key, VITE_API_URL, VITE_USE_EMULATORS
    ├── tailwind.config.js   Colours as CSS variables (light/dark), NYSC green
    ├── public/
    │   ├── firebase-messaging-sw.js   Service worker: FCM background messages + offline cache
    │   ├── manifest.webmanifest       PWA manifest
    │   └── icon.svg, icon-192.png, icon-512.png
    └── src/
        ├── main.tsx, App.tsx          Bootstrap + routing (auth state → which routes)
        ├── index.css                  Theme variables, components (.screen .card .input), print styles
        ├── lib/                       firebase (init + callable), api (all actions), rules (client mirror of shared.ts),
        │                              types, messaging (FCM), sw, theme, install (PWA gate), image (compress), upload,
        │                              offlineQueue, toast, tagImage (PNG tag), money, device, signupLock
        ├── hooks/                     useAuth, useLive (Firestore listeners), useMyDay, useExco
        ├── components/                ui (Button, Field, Icon…), Avatar, BottomNav, SideNav, ExcoHeader, MemberCard,
        │                              QRScan, TagCard3D, Hero3D, PhotoPicker, Toaster, ThemeToggle, InstallGate, ErrorBoundary
        └── pages/
            ├── Welcome, Signup, Login, Pending
            ├── member/  Home, ScanIn, MyTag, Dues, Profile
            └── exco/    Dashboard, Door, CallBatch, Table, Members, DuesAdmin, Settings, PrintCards
```

---

## 4. Firestore data model

```
users/{uid}
  stateCode, fullName, phone (+234…), photoURL, groupId, role: 'member'|'exco',
  status: 'pending'|'approved'|'rejected', fcmTokens: string[], createdAt, approvedAt, approvedBy

groups/{gid}
  name, lga, state, joinCode (6 chars), batchSize (default 20),
  venue: { lat, lng, radiusM } | null,
  payout: { bankName, accountName, last4, setBy, setAt } | undefined,
  createdBy, createdAt

groups/{gid}/private/keys        { doorSecret }              ← HMAC secret for door codes (never readable by clients)
groups/{gid}/private/payout      { subaccountCode }          ← Paystack subaccount (never readable by clients)

groups/{gid}/logs/{auto}         { at, sessionId, by, action, target?, stateCode?, label?, reason?, … }

groups/{gid}/sessions/{YYYY-MM-DD}     (one CDS meeting per day, Lagos date)
  status: 'open'|'closed', nextNumber, nextPriority, lastTo, batchSeq,
  batch: { kind:'priority', seq, calledAt } | { kind:'regular', seq, from, to, calledAt } | null
groups/{gid}/sessions/{date}/attendees/{uid}
  uid, number, priority, pNumber, status: 'waiting'|'done', method: 'self'|'offline'|'card'|'manual',
  by, checkedInAt, syncedAt, doneAt, doneBy, fullName, stateCode, photoURL

groups/{gid}/dues/{duesId}       { title, amountKobo, dueDate (YYYY-MM-DD|null), active, createdBy, createdAt }
groups/{gid}/dues/{duesId}/status/{uid}
  { uid, status: 'paid'|'cash_pending', method: 'online'|'cash', amountKobo, reference, fullName, stateCode,
    recordedBy?, recordedByName?, paidAt?, recordedAt? }
groups/{gid}/payments/{reference}
  { reference, uid, duesId, duesTitle, amountKobo, feeKobo, totalKobo, method, status:
    'pending'|'paid'|'awaiting_member'|'disputed', recordedBy?, fullName, stateCode, createdAt, paidAt? }
```
Online references look like `cds-<gid>-<12 hex>` (the webhook parses `gid` out of it); cash: `cash-<gid>-<hex>`.

**Read access (firestore.rules):** own user doc or exco of the same group; group, sessions, dues → approved members
of the group; attendees, dues status, payments → own doc or exco; logs → excos; `private/*` → nobody.

---

## 5. API actions (`POST /api/<name>`, body `{ data }`)

Auth levels: **signed-in** (any login), **member** (approved, claims gid), **exco** (also re-checked against the live
`users` doc, so a removed exco loses power immediately).

| Action | Level | Data | Does |
|---|---|---|---|
| `registerMember` | signed-in | stateCode, fullName, phone, photoURL, joinCode | Creates user (pending), claims {gid, member, approved:false} |
| `createGroup` | signed-in | stateCode, fullName, phone, photoURL, group{name,lga,state} | Creates group + door secret + exco user (approved) |
| `approveMember` | exco | uid \| stateCode, approve | Approve/reject pending member, sets claims |
| `setRole` | exco | uid, role | Make/remove exco (can't demote self) |
| `resetPin` | exco | uid, pin (6 digits) | Sets new password |
| `updateGroupSettings` | exco | batchSize? venue{lat,lng,radiusM}? clearVenue? | Settings |
| `startSession` / `endSession` | exco | — | Open/close today's meeting (Lagos date) |
| `getDoorCode` | exco | — | `{code, gid, sessionId, expiresAt}`; code = HMAC(secret, gid\|date\|30-s window) % 1e6 |
| `checkIn` | member | code, gid?, lat?, lng?, scannedAt? (offline) | Validates code (current or previous window), venue distance, gives next number |
| `lookupMember` | exco | uid \| stateCode | Member + today's attendee |
| `excoCheckIn` | exco | uid \| stateCode, method 'card'\|'manual' | Assisted check-in (manual is logged) |
| `setPriority` | exco | uid \| stateCode | Gives P-number |
| `callNext` | exco | mode 'priority'\|'next' | Sets session.batch, notifies the batch via FCM |
| `tableCheck` | exco | uid \| stateCode | `your_turn` \| `not_turn` \| `already_done` \| `not_checked_in` \| `not_started` (+member, number) |
| `markDone` | exco | uid \| stateCode | Re-checks turn, marks thumbprinted |
| `listBanks` | exco | — | Paystack bank list |
| `resolveAccount` | exco | bankCode, accountNumber | Account name |
| `setPayoutAccount` | exco | bankCode, bankName, accountNumber | Create/update Paystack subaccount; group.payout |
| `createDues` / `closeDues` | exco | title, amountNaira, dueDate? / duesId | Dues items |
| `startPayment` | member | duesId, returnUrl | Paystack `/transaction/initialize` with `subaccount`, `transaction_charge = 3% + 1.5% (duesCharges in shared.ts)`, `bearer: 'account'` → `{authorizationUrl}` |
| `verifyPayment` | member | reference | Paystack verify → settle |
| `recordCash` | exco | uid, duesId | status `cash_pending`, notifies member |
| `respondCash` | member | duesId, confirm | confirm → paid; dispute → removed + logged |
| `remindDues` | exco | duesId | Pushes to everyone not paid |

Also: `POST /paystack/webhook` (raw body, HMAC-SHA512 signature check with the secret key, `charge.success` → settle)
and `GET /health`.

**Turn rule (`isTurn` in shared.ts and web/src/lib/rules.ts):** no batch → false; status must be `waiting`;
priority → true once any batch is called; regular → `batch.kind === 'regular' && number <= batch.to`
(so No. 41 is refused while 21–40 is called, but someone from an earlier batch who missed their call can still come).

---

## 6. Key flows

- **Sign-up** (`pages/Signup.tsx`): Details → Photo (compressed to 512 px JPEG, `lib/image.ts`) → Group (join code
  or create) → PIN + consent. `createUserWithEmailAndPassword` → upload avatar to Storage → `registerMember` or
  `createGroup` → refresh claims. `lib/signupLock.ts` keeps the sign-up screen mounted while the account exists but
  the profile doesn't yet. If sign-up was interrupted, the app shows "Finish signing up" (profile === null).
- **Routing** (`App.tsx`): loading → Splash; no user → Welcome/Login/Signup; user without profile → finish sign-up;
  pending/rejected → Pending; approved + claims ready → member routes (`/home /scan /tag /dues /profile`) and,
  for excos, `/exco/*`.
- **Door:** exco screen refreshes the code ~every 25 s; QR payload `CDSPASS:D:<gid>:<code>`. Member tag/card QR:
  `CDSPASS:M:<uid>`. No-phone members: exco scans printed card or types state code.
- **Offline check-in** (`lib/offlineQueue.ts`): scan saved to localStorage with `scannedAt`; sent when online;
  server accepts if the code matches the window of `scannedAt` (≤ 6 h old). Number is assigned at sync time.
- **Batch alert:** `callNext` → FCM data message `{title, body, link}` to tokens in `users.fcmTokens`; service worker
  shows the notification; when the app is open, `useMyDay` vibrates + toasts when `isTurn` becomes true.
- **Dues online:** member taps Pay → `startPayment` → redirect to Paystack → back to `/dues?reference=…` →
  `verifyPayment`; webhook also settles. **Cash:** exco `recordCash` → member `respondCash`.
- **Install gate** (`components/InstallGate.tsx`, `lib/install.ts`): on phones, in **production builds over HTTPS
  only**, the app requires being installed (Android `beforeinstallprompt`, iOS "Add to Home Screen" instructions,
  in-app browsers told to open Chrome/Safari). Laptops are never gated; dev builds are never gated.
- **Theme:** CSS variables in `index.css` (`:root` light, `.dark` dark), `lib/theme.ts` (system/light/dark),
  `.theme-light` forces light colours on things that must stay white (QR codes, printed cards).
- **Layout:** phones = single column + bottom nav; `lg` screens = sidebar (`SideNav`) + wider content; stand-alone
  pages (`.screen`) are a framed window on desktop.
- **Shareable tag:** `lib/tagImage.ts` draws a 1080×1350 PNG (photo, name, number, status, QR) and uses
  `navigator.share({files})` or downloads it. Photo needs Storage CORS (`cors.json`), else initials are drawn.

---

## 7. Environment variables

**web/.env** (Vite, public values only — never put secrets here)
```
VITE_FB_API_KEY, VITE_FB_AUTH_DOMAIN, VITE_FB_PROJECT_ID, VITE_FB_STORAGE_BUCKET,
VITE_FB_MESSAGING_SENDER_ID, VITE_FB_APP_ID     Firebase web config
VITE_FB_VAPID_KEY                               Cloud Messaging → Web Push certificate
VITE_API_URL                                    http://localhost:8787 (dev) / https://<render-app>.onrender.com
VITE_USE_EMULATORS                              true (dev) / false (live)
VITE_SERVICE_FEE_PERCENT=3, VITE_PAYSTACK_FEE_PERCENT=1.5   (display only; must match server)
```
For local emulator use, the Firebase values can be dummies: project `demo-cds-pass`, api key `demo-key`.

**server** (dev: `server/dev.env` + optional `server/keys.env`; live: Render → Environment)
```
PORT                       8787 locally; Render sets it
CORS_ORIGINS               comma list, e.g. http://localhost:5173 / https://<id>.web.app,https://<id>.firebaseapp.com
GCLOUD_PROJECT             demo-cds-pass (dev, emulators)
FIRESTORE_EMULATOR_HOST    127.0.0.1:8080 (dev only)
FIREBASE_AUTH_EMULATOR_HOST 127.0.0.1:9099 (dev only)
FIREBASE_STORAGE_EMULATOR_HOST 127.0.0.1:9199 (dev only)
FIREBASE_SERVICE_ACCOUNT   live only: service-account JSON (raw or base64)
FIREBASE_STORAGE_BUCKET    live: <id>.firebasestorage.app
PAYSTACK_SECRET_KEY        sk_test_… / sk_live_…  (secret!)
SERVICE_FEE_PERCENT        3      PAYSTACK_FEE_PERCENT   1.5
```

---

## 8. Run, deploy

**Local development (Windows, 3 terminals)**
```powershell
# 1 Firebase emulators (needs Java 21 + firebase-tools)
cd C:\Projects\cds-pass
firebase emulators:start --project demo-cds-pass
# 2 API server
cd C:\Projects\cds-pass\server
npm install        # first time
npm run dev        # or: npm run dev:keys   (with server\keys.env for Paystack)
# 3 website
cd C:\Projects\cds-pass\web
npm install        # first time
npm run dev        # http://localhost:5173 ; emulator UI http://127.0.0.1:4000
```
Emulator data is wiped on every restart → sign up again.

**Live:** Firebase project (Auth email/password, Firestore `europe-west1`, Storage — needs Blaze on new projects,
Web app config, VAPID key, service-account key) → GitHub repo → Render Blueprint (`render.yaml`, set env vars) →
`web/.env` real values + `VITE_API_URL` → `firebase use --add` → `firebase deploy` (builds web automatically) →
Paystack webhook `https://<render-app>.onrender.com/paystack/webhook` → cron-job.org ping `/health` every 10 min
(Render free tier sleeps after 15 min idle; first request ~50 s; the web shows "Server is waking up…").

---

## 9. Known issues, limits and troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `localhost:9099 … ERR_CONNECTION_REFUSED` in the browser console | Auth emulator not running (website set to `VITE_USE_EMULATORS=true`) | Start `firebase emulators:start --project demo-cds-pass` and wait for "All emulators ready!" |
| `Failed to fetch` / "No internet connection" on any action | API server (port 8787) not running, or CORS_ORIGINS doesn't include the site's origin | `cd server; npm run dev`; check `CORS_ORIGINS` |
| "Your login has expired" right after restarting emulators | Browser kept a login from wiped emulator data | Log out / refresh (app auto-signs-out when the user no longer exists) |
| "Online payments are not set up yet" | `PAYSTACK_SECRET_KEY` missing | `server/keys.env` + `npm run dev:keys`, or Render env var |
| Account-name check fails in Paystack test mode | Paystack test mode only resolves a few test accounts | Expected in test mode |
| No push notifications locally | FCM needs the real Firebase project + VAPID key | Test after deploy; in-app buzz works locally |
| iPhone gets no push | iOS only allows web push for installed apps (iOS 16.4+) | Add to Home Screen, open from icon, turn on alerts |
| Shared tag image shows initials | Storage CORS not set | `gsutil cors set cors.json gs://<bucket>` |
| First action of the day is slow (live) | Render free tier asleep | cron-job.org ping |

Limits of v1: offline scans get their number at sync time; no SMS fallback; NYSC can't verify state codes
(exco approval with ID card instead); one session per group per Lagos calendar day; exco/member collusion is
deterred by the immutable log, not prevented.

Conventions: TypeScript strict everywhere; money in **kobo** (integers); dates of meetings are Lagos `YYYY-MM-DD`;
user-facing errors are thrown as `HttpsError(code, plain-English message)`; UI copy is short, plain English for
Nigerian corps members; never put secrets in `web/`.

---

## 10. Full source code

Every file of the project follows (excluding `node_modules`, lock files, build output, binary icons and `.env` files).

Files in this section:

- `.firebaserc.example`
- `.gitignore`
- `cors.json`
- `firebase.json`
- `firestore.indexes.json`
- `firestore.rules`
- `render.yaml`
- `storage.rules`
- `server/dev.env`
- `server/package.json`
- `server/src/admin.ts`
- `server/src/compat.ts`
- `server/src/handlers.ts`
- `server/src/main.ts`
- `server/src/mongo.ts`
- `server/src/shared.ts`
- `server/src/upload.ts`
- `server/tsconfig.json`
- `web/.env.example`
- `web/index.html`
- `web/package.json`
- `web/postcss.config.js`
- `web/public/.htaccess`
- `web/public/firebase-messaging-sw.js`
- `web/public/icon.svg`
- `web/public/manifest.webmanifest`
- `web/scripts/generate-share-card.ps1`
- `web/src/App.tsx`
- `web/src/components/Avatar.tsx`
- `web/src/components/BottomNav.tsx`
- `web/src/components/ErrorBoundary.tsx`
- `web/src/components/ExcoHeader.tsx`
- `web/src/components/Hero3D.tsx`
- `web/src/components/InstallGate.tsx`
- `web/src/components/MemberCard.tsx`
- `web/src/components/PhotoPicker.tsx`
- `web/src/components/PlatformChrome.tsx`
- `web/src/components/QRScan.tsx`
- `web/src/components/SideNav.tsx`
- `web/src/components/TagCard3D.tsx`
- `web/src/components/ThemeToggle.tsx`
- `web/src/components/Toaster.tsx`
- `web/src/components/ui.tsx`
- `web/src/hooks/useAuth.tsx`
- `web/src/hooks/useExco.ts`
- `web/src/hooks/useLive.ts`
- `web/src/hooks/useMyDay.ts`
- `web/src/hooks/usePlatform.ts`
- `web/src/index.css`
- `web/src/lib/api.ts`
- `web/src/lib/appConfig.ts`
- `web/src/lib/device.ts`
- `web/src/lib/firebase.ts`
- `web/src/lib/image.ts`
- `web/src/lib/install.ts`
- `web/src/lib/messaging.ts`
- `web/src/lib/money.ts`
- `web/src/lib/offlineQueue.ts`
- `web/src/lib/rules.ts`
- `web/src/lib/signupDraft.ts`
- `web/src/lib/signupLock.ts`
- `web/src/lib/sw.ts`
- `web/src/lib/tagImage.ts`
- `web/src/lib/theme.ts`
- `web/src/lib/toast.ts`
- `web/src/lib/types.ts`
- `web/src/lib/upload.ts`
- `web/src/main.tsx`
- `web/src/pages/Login.tsx`
- `web/src/pages/Pending.tsx`
- `web/src/pages/Signup.tsx`
- `web/src/pages/Welcome.tsx`
- `web/src/pages/admin/Admin.tsx`
- `web/src/pages/admin/Charts.tsx`
- `web/src/pages/exco/CallBatch.tsx`
- `web/src/pages/exco/Dashboard.tsx`
- `web/src/pages/exco/Door.tsx`
- `web/src/pages/exco/DuesAdmin.tsx`
- `web/src/pages/exco/GiveNumber.tsx`
- `web/src/pages/exco/Members.tsx`
- `web/src/pages/exco/Messages.tsx`
- `web/src/pages/exco/PrintCards.tsx`
- `web/src/pages/exco/Settings.tsx`
- `web/src/pages/exco/Table.tsx`
- `web/src/pages/member/Dues.tsx`
- `web/src/pages/member/Home.tsx`
- `web/src/pages/member/MyTag.tsx`
- `web/src/pages/member/Profile.tsx`
- `web/src/pages/member/ScanIn.tsx`
- `web/tailwind.config.js`
- `web/tsconfig.json`
- `web/vite.config.ts`

---

### `.firebaserc.example`

```bash
{
  "projects": {
    "default": "your-firebase-project-id"
  }
}
```

---

### `.gitignore`

```
node_modules/
dist/
functions/lib/
.env
.env.*
!.env.example
.firebaserc
.firebase/
*.log
firebase-debug.*
.DS_Store
.secret.local
server/dist/
server/keys.env
```

---

### `cors.json`

```json

[
  {
    "origin": [
      "https://cdspass.name.ng"
    ],
    "method": [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "HEAD"
    ],
    "maxAgeSeconds": 3600,
    "responseHeader": [
      "Content-Type",
      "Authorization",
      "x-goog-resumable"
    ]
  }
]
```

---

### `firebase.json`

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "emulators": {
    "auth": {
      "port": 9099
    },
    "firestore": {
      "port": 8080
    },
    "ui": {
      "enabled": true
    }
  }
}
```

---

### `firestore.indexes.json`

```json
{
  "indexes": [],
  "fieldOverrides": []
}
```

---

### `firestore.rules`

```javascript
rules_version = '2';

// CDS Pass security rules.
// Everything that matters (numbers, turns, approvals, check-ins) is written
// ONLY by Cloud Functions. Phones can read what they are allowed to see,
// and can only change their own phone number, photo and notification tokens.
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    // Approved member of this CDS group (claims are set by Cloud Functions).
    function inGroup(gid) {
      return signedIn()
        && request.auth.token.gid == gid
        && request.auth.token.approved == true;
    }

    function isExco(gid) {
      return inGroup(gid) && request.auth.token.role == 'exco';
    }

    match /users/{uid} {
      allow read: if signedIn()
        && (request.auth.uid == uid || isExco(resource.data.groupId));

      // A member may only change these fields on their own profile.
      allow update: if signedIn()
        && request.auth.uid == uid
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['phone', 'photoURL', 'fcmTokens', 'updatedAt']);

      allow create, delete: if false;
    }

    // Main-exco state-code reservations are written and consumed only by the API server.
    match /mainExcoReservations/{reservationId} {
      allow read, write: if false;
    }

    match /groups/{gid} {
      allow read: if inGroup(gid);
      allow write: if false;

      // Door-code secret. Never readable from a phone.
      match /private/{doc} {
        allow read, write: if false;
      }

      // Activity log: excos can read, nobody can edit.
      match /logs/{logId} {
        allow read: if isExco(gid);
        allow write: if false;
      }

      // Dues: everyone in the group sees what's due; each member sees only their own
      // status and receipts; excos see everyone's. Only the server writes.
      match /dues/{duesId} {
        allow read: if inGroup(gid);
        allow write: if false;

        match /status/{uid} {
          allow read: if (inGroup(gid) && request.auth.uid == uid) || isExco(gid);
          allow write: if false;
        }
      }

      match /payments/{ref} {
        allow read: if (inGroup(gid) && resource.data.uid == request.auth.uid) || isExco(gid);
        allow write: if false;
      }

      match /sessions/{sid} {
        allow read: if inGroup(gid);
        allow write: if false;

        match /attendees/{uid} {
          allow read: if (inGroup(gid) && request.auth.uid == uid) || isExco(gid);
          allow write: if false;
        }
      }
    }
  }
}
```

---

### `render.yaml`

```yaml
# Render blueprint: New → Blueprint → pick this repo. Creates the free API server.
services:
  - type: web
    name: cds-pass-api
    runtime: node
    plan: free
    region: frankfurt
    rootDir: server
    buildCommand: npm install --include=dev && npm run build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: NODE_VERSION
        value: "20"
      - key: SERVICE_FEE_PERCENT
        value: "3"
      - key: PAYSTACK_FEE_PERCENT
        value: "1.5"
      # Fill these in on the Render dashboard (never commit them):
      - key: CORS_ORIGINS # Set to https://cdspass.name.ng in the Render dashboard.
        sync: false
      - key: PLATFORM_ADMIN_STATE_CODE
        value: LA/26B/2578
      - key: CRON_SECRET # any long random text; cron-job.org calls /cron/reminders?key=<this>
        sync: false
      - key: FIREBASE_SERVICE_ACCOUNT # service-account JSON (or base64 of it)
        sync: false
      - key: FIREBASE_STORAGE_BUCKET # e.g. your-id.firebasestorage.app
        sync: false
      - key: MONGODB_URI # MongoDB Atlas connection string; keep this server-side only.
        sync: false
      - key: MONGODB_DATABASE
        value: cds_pass
      - key: PAYSTACK_SECRET_KEY
        sync: false
      - key: CLOUDINARY_CLOUD_NAME
        sync: false
      - key: CLOUDINARY_API_KEY
        sync: false
      - key: CLOUDINARY_API_SECRET
        sync: false
```

---

### `storage.rules`

```javascript
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    // Profile pictures: avatars/{uid}/{file}
    match /avatars/{uid}/{file} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.size < 2 * 1024 * 1024
        && request.resource.contentType.matches('image/.*');
    }
  }
}
```

---

### `server/dev.env`

```bash
# Local development settings (no secrets here). `npm run dev` loads this file.
PORT=8787
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
PLATFORM_ADMIN_STATE_CODE=LA/26B/2578

# Talk to the Firebase emulators running on this PC
GCLOUD_PROJECT=demo-cds-pass
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099

# Online dues charges on top of the dues: 3% yours + 1.5% for Paystack
SERVICE_FEE_PERCENT=3
PAYSTACK_FEE_PERCENT=1.5

# Secrets NEVER go in this file (it is uploaded to GitHub). Put them in server/keys.env, which is ignored:
#   PAYSTACK_SECRET_KEY=sk_test_...
#   CLOUDINARY_CLOUD_NAME=...  CLOUDINARY_API_KEY=...  CLOUDINARY_API_SECRET=...
#   MONGODB_URI=...   (leave out to keep the activity log in the local Firestore emulator)
# then run `npm run dev:keys`.
```

---

### `server/package.json`

```json
{
  "name": "cds-pass-server",
  "private": true,
  "version": "0.1.0",
  "main": "dist/main.js",
  "engines": {
    "node": ">=20.6"
  },
  "scripts": {
    "dev": "tsx watch --env-file=dev.env src/main.ts",
    "dev:keys": "tsx watch --env-file=dev.env --env-file=keys.env src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "cloudinary": "^2.5.1",
    "cors": "^2.8.5",
    "express": "^4.21.1",
    "firebase-admin": "^12.6.0",
    "mongodb": "^7.8.0",
    "multer": "^2.0.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/multer": "^1.4.13",
    "@types/node": "^20.16.10",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2"
  }
}
```

---

### `server/src/admin.ts`

```ts
import { cert, getApps, initializeApp } from 'firebase-admin/app';

/**
 * Connects to Firebase.
 * - Live (Render): FIREBASE_SERVICE_ACCOUNT holds the service-account JSON (raw or base64).
 * - Local: no key needed; the *_EMULATOR_HOST variables in dev.env point at the emulators.
 */
export function initAdmin() {
  if (getApps().length) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (sa) {
    const json = JSON.parse(sa.startsWith('{') ? sa : Buffer.from(sa, 'base64').toString('utf8'));
    initializeApp({
      credential: cert(json),
      projectId: json.project_id,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    console.log(`Firebase: connected to project ${json.project_id}`);
  } else {
    const projectId = process.env.GCLOUD_PROJECT || 'demo-cds-pass';
    initializeApp({ projectId });
    console.log(`Firebase: using local emulators for ${projectId}`);
  }
}
```

---

### `server/src/compat.ts`

```ts
/**
 * Tiny stand-ins for the Firebase Functions helpers, so the same handler code
 * runs inside a normal Express server on Render.
 */
export type FunctionsErrorCode =
  | 'ok'
  | 'cancelled'
  | 'unknown'
  | 'invalid-argument'
  | 'deadline-exceeded'
  | 'not-found'
  | 'already-exists'
  | 'permission-denied'
  | 'resource-exhausted'
  | 'failed-precondition'
  | 'aborted'
  | 'out-of-range'
  | 'unimplemented'
  | 'internal'
  | 'unavailable'
  | 'data-loss'
  | 'unauthenticated';

/** An error the member is meant to see, with a status code. */
export class HttpsError extends Error {
  constructor(
    public code: FunctionsErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface CallableRequest<T = any> {
  data: T;
  /** Set when the request carried a valid Firebase login token. */
  auth?: { uid: string; token: Record<string, unknown> };
  rawRequest?: unknown;
}

type CallHandler = (req: CallableRequest) => unknown | Promise<unknown>;
export interface Callable {
  __callable: true;
  handler: CallHandler;
}

/** onCall(handler) or onCall(options, handler) — options are ignored here. */
export function onCall(a: unknown, b?: CallHandler): Callable {
  const handler = (typeof a === 'function' ? a : b) as CallHandler;
  return { __callable: true, handler };
}

type RequestHandler = (req: any, res: any) => unknown | Promise<unknown>;
export interface RawEndpoint {
  __request: true;
  handler: RequestHandler;
}

export function onRequest(a: unknown, b?: RequestHandler): RawEndpoint {
  const handler = (typeof a === 'function' ? a : b) as RequestHandler;
  return { __request: true, handler };
}

export function setGlobalOptions(_opts: unknown) {
  /* not needed on Render */
}

/** Secrets come from environment variables (server/.env locally, Render → Environment live). */
export function defineSecret(name: string) {
  return { value: () => process.env[name] ?? '' };
}
```

---

### `server/src/handlers.ts`

```ts
/**
 * CDS Pass — API handlers (served by the Express app in main.ts, hosted on Render).
 *
 * Every rule that stops cheating lives here, on the server:
 *  - door codes change every 30 seconds and are signed with a per-group secret
 *  - optional venue location check
 *  - numbers are handed out strictly in arrival order, one per person per day
 *  - turn checks at the thumbprint table (No. 41 is refused while 21–40 is called)
 *  - every exco action is written to an activity log nobody can edit
 */
import { onCall, onRequest, HttpsError, CallableRequest, setGlobalOptions, defineSecret } from './compat';
import { initAdmin } from './admin';
import { getFirestore, FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { mongoCollection, mongoConfigured } from './mongo';
import { createHmac, randomBytes, randomInt } from 'crypto';
import {
  Batch,
  distanceM,
  isTurn,
  lagosDate,
  normalizePhone,
  normalizeStateCode,
  stateCodeToEmail,
  duesCharges,
} from './shared';

initAdmin();
setGlobalOptions({});

const db = getFirestore();
const auth = getAuth();

const WINDOW_MS = 30_000; // door code lifetime
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_RADIUS_M = 300;

type Role = 'member' | 'exco';
interface Claims {
  gid?: string;
  role?: Role;
  approved?: boolean;
}

// ---------------------------------------------------------------- helpers

const fail = (code: ConstructorParameters<typeof HttpsError>[0], msg: string) =>
  new HttpsError(code, msg);

const userRef = (uid: string) => db.doc(`users/${uid}`);
const groupRef = (gid: string) => db.doc(`groups/${gid}`);
const keysRef = (gid: string) => db.doc(`groups/${gid}/private/keys`);
const sessionRef = (gid: string, sid: string) => db.doc(`groups/${gid}/sessions/${sid}`);
const sessionCounterRef = (gid: string, sid: string) => db.doc(`groups/${gid}/private/session-${sid}`);
const mainExcoReservationRef = (stateCode: string) => db.doc(`mainExcoReservations/${stateCode.replace(/\//g, '')}`);
const attendeeRef = (gid: string, sid: string, uid: string) =>
  db.doc(`groups/${gid}/sessions/${sid}/attendees/${uid}`);

async function log(gid: string, by: string, action: string, detail: Record<string, unknown> = {}) {
  const entry = {
    gid,
    at: new Date(),
    sessionId: lagosDate(),
    by,
    action,
    ...detail,
  };
  if (mongoConfigured()) {
    try {
      await (await mongoCollection('activity_logs')).insertOne(entry);
      return;
    } catch (error) {
      console.error('MongoDB activity log write failed; using Firestore fallback.', error);
    }
  }
  await db.collection(`groups/${gid}/logs`).add({ ...entry, at: FieldValue.serverTimestamp() });
}

/** Activity history is read on demand; the live meeting and member data stay in Firestore. */
export const getLogs = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const requestedLimit = Number(req.data?.limit ?? 40);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 40;

  if (mongoConfigured()) {
    try {
      const collection = await mongoCollection<any>('activity_logs');
      if (!(await collection.countDocuments({ gid: e.gid }))) {
        const legacy = await db.collection(`groups/${e.gid}/logs`).orderBy('at', 'desc').limit(1000).get();
        if (!legacy.empty) {
          await collection.bulkWrite(legacy.docs.map((doc) => {
            const { at, ...data } = doc.data();
            return {
              updateOne: {
                filter: { _id: doc.id },
                update: { $setOnInsert: { ...data, gid: e.gid, at: (at as Timestamp | undefined)?.toDate() ?? new Date(0) } },
                upsert: true,
              },
            };
          }));
        }
      }
      const entries = await collection
        .find({ gid: e.gid })
        .sort({ at: -1 })
        .limit(limit)
        .toArray();
      if (entries.length) {
        return entries.map(({ _id, at, ...entry }) => ({
          ...entry,
          id: String(_id),
          atMs: at instanceof Date ? at.getTime() : null,
        }));
      }
      // Keep the existing Firestore history visible during the one-time migration.
    } catch (error) {
      console.error('MongoDB activity log read failed; using Firestore fallback.', error);
    }
  }

  const legacy = await db.collection(`groups/${e.gid}/logs`).orderBy('at', 'desc').limit(limit).get();
  return legacy.docs.map((doc) => {
    const data = doc.data();
    const at = data.at as Timestamp | undefined;
    return { ...data, id: doc.id, atMs: at?.toMillis() ?? null };
  });
});

function signedIn(req: CallableRequest): { uid: string; claims: Claims } {
  if (!req.auth) throw fail('unauthenticated', 'Please log in first.');
  return { uid: req.auth.uid, claims: req.auth.token as Claims };
}

function approvedMember(req: CallableRequest) {
  const { uid, claims } = signedIn(req);
  if (!claims.gid || !claims.approved) {
    throw fail('permission-denied', 'Your account has not been approved by an exco yet.');
  }
  return { uid, gid: claims.gid };
}

/** Exco check reads the live profile too, so a removed exco loses power immediately. */
async function exco(req: CallableRequest) {
  const { uid, gid } = approvedMember(req);
  const snap = await userRef(uid).get();
  const u = snap.data();
  if (!u || u.role !== 'exco' || u.status !== 'approved' || u.groupId !== gid) {
    throw fail('permission-denied', 'Only excos of this CDS group can do this.');
  }
  return { uid, gid, name: u.fullName as string };
}

/** The group creator is the main exco and owns role assignments and dues creation. */
async function mainExco(req: CallableRequest) {
  const e = await exco(req);
  const group = (await groupRef(e.gid).get()).data();
  if (!group || (group.mainExcoUid ?? group.createdBy) !== e.uid) {
    throw fail('permission-denied', 'Only the main exco who created this CDS group can do this.');
  }
  return e;
}

async function platformAdmin(req: CallableRequest) {
  const { uid } = signedIn(req);
  const adminStateCode = normalizeStateCode(process.env.PLATFORM_ADMIN_STATE_CODE);
  // Admin-team members may create groups too (registerPlatformAdmin below still checks the owner's state code).
  const r = await roleForEmail((req.auth?.token?.email as string | undefined) ?? (await auth.getUser(uid)).email);
  if (r && (r.role === 'owner' || r.role === 'admin')) return { uid, adminStateCode: adminStateCode ?? r.stateCode };
  const account = await auth.getUser(uid);
  if (!adminStateCode || account.email?.toLowerCase() !== stateCodeToEmail(adminStateCode).toLowerCase()) {
    throw fail('permission-denied', 'Only the CDS Pass platform administrator can create CDS groups.');
  }
  return { uid, adminStateCode };
}

function text(v: unknown, label: string, min: number, max: number): string {
  if (typeof v !== 'string') throw fail('invalid-argument', `${label} is required.`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) {
    throw fail('invalid-argument', `${label} must be ${min}–${max} characters.`);
  }
  return s;
}

/**
 * 6-digit door code for a 30-second window. `epoch` goes up each time the main exco gives someone a
 * number by hand, which makes the code on the door screen change straight away (old one stops working).
 */
function doorCode(secret: string, gid: string, sid: string, window: number, epoch = 0): string {
  const h = createHmac('sha256', secret).update(epoch ? `${gid}|${sid}|${window}|${epoch}` : `${gid}|${sid}|${window}`).digest();
  const n = h.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

function newJoinCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** Validates the profile fields every new account needs. */
async function validateProfile(uid: string, data: any) {
  const stateCode = normalizeStateCode(data?.stateCode);
  if (!stateCode) throw fail('invalid-argument', 'Enter a valid state code, e.g. LA/26B/1142.');

  // The login email is derived from the state code, so this proves the account owns it.
  let authUser;
  try {
    authUser = await auth.getUser(uid);
  } catch {
    throw fail('unauthenticated', 'Your login has expired. Log out and sign up again.');
  }
  if (authUser.email !== stateCodeToEmail(stateCode)) {
    throw fail('permission-denied', 'This state code does not match your account.');
  }

  const fullName = text(data?.fullName, 'Full name', 3, 80);
  const phone = normalizePhone(data?.phone);
  if (!phone) throw fail('invalid-argument', 'Enter a valid Nigerian phone number.');

  // The photo may come later: on slow networks the upload can fail, and that must not block sign-up.
  // Members without a photo are asked to add one on the "Under review" screen.
  const rawPhoto = data?.photoURL ?? null;
  if (rawPhoto !== null && (typeof rawPhoto !== 'string' || !/^https:\/\//.test(rawPhoto) || rawPhoto.length > 2000)) {
    throw fail('invalid-argument', 'That profile picture link is not valid. Please choose the photo again.');
  }
  const photoURL: string | null = rawPhoto;

  if ((await userRef(uid).get()).exists) {
    throw fail('already-exists', 'This account is already registered.');
  }
  return { stateCode, fullName, phone, photoURL };
}

/** Finds an approved member of the group by uid or state code. */
async function findMember(gid: string, data: any) {
  let uid: string | undefined = typeof data?.uid === 'string' ? data.uid : undefined;
  if (!uid && data?.stateCode) {
    const sc = normalizeStateCode(data.stateCode);
    if (!sc) throw fail('invalid-argument', 'That is not a valid state code.');
    try {
      uid = (await auth.getUserByEmail(stateCodeToEmail(sc))).uid;
    } catch {
      throw fail('not-found', 'No CDS Pass account with that state code.');
    }
  }
  if (!uid) throw fail('invalid-argument', 'Scan a tag or enter a state code.');
  const snap = await userRef(uid).get();
  const u = snap.data();
  if (!u || u.groupId !== gid) throw fail('not-found', 'This person is not in your CDS group.');
  return { uid, user: u };
}

function publicMember(uid: string, u: FirebaseFirestore.DocumentData) {
  return {
    uid,
    fullName: u.fullName,
    stateCode: u.stateCode,
    photoURL: u.photoURL ?? null,
    status: u.status,
    role: u.role,
  };
}

/**
 * "Pay before you get a number": dues marked requiredForCheckIn block check-in from their collection
 * date onwards until the member has paid (online, or cash recorded by an exco).
 * Throws a message that starts with "Dues not paid" so the app can show the red pay screen.
 */
async function assertDuesPaid(gid: string, uid: string, fullName: string, forExco: boolean) {
  const today = lagosDate();
  const open = await db.collection(`groups/${gid}/dues`).where('active', '==', true).get();
  const gating = open.docs.filter((d) => d.data().requiredForCheckIn === true && (!d.data().dueDate || d.data().dueDate <= today));
  if (!gating.length) return;
  const statuses = await db.getAll(...gating.map((d) => duesStatusRef(gid, d.id, uid)));
  const unpaid = gating.filter((_, i) => statuses[i].data()?.status !== 'paid');
  if (!unpaid.length) return;
  const what = unpaid.map((d) => `${d.data().title} (${naira(d.data().amountKobo)})`).join(', ');
  throw fail(
    'failed-precondition',
    forExco
      ? `Dues not paid: ${fullName} still owes ${what}. Record their cash payment in Dues first, then check them in.`
      : `Dues not paid: please pay ${what} before you can get a number. Pay online in the app, or pay cash to an exco and scan again.`,
  );
}

/** Gives a person the next number in today's queue (once). */
async function admit(
  gid: string,
  sid: string,
  uid: string,
  method: 'self' | 'offline' | 'card' | 'manual',
  by: string,
  atMs: number,
) {
  const u = (await userRef(uid).get()).data();
  if (!u || u.status !== 'approved') throw fail('failed-precondition', 'This member is not approved yet.');
  // Already in today's queue? Then they keep their number, paid or not.
  const existing = await attendeeRef(gid, sid, uid).get();
  if (!existing.exists) {
    await assertGroupActive(gid);
    await assertDuesPaid(gid, uid, u.fullName, by !== uid);
  }

  return db.runTransaction(async (tx) => {
    const sRef = sessionRef(gid, sid);
    const aRef = attendeeRef(gid, sid, uid);
    const cRef = sessionCounterRef(gid, sid);
    const [s, a, c] = await Promise.all([tx.get(sRef), tx.get(aRef), tx.get(cRef)]);
    if (!s.exists || s.data()!.status !== 'open') {
      throw fail('failed-precondition', "Today's CDS meeting has not been opened by an exco yet.");
    }
    if (a.exists) return { number: a.data()!.number as number, already: true };

    const number = (c.data()?.nextNumber ?? s.data()!.nextNumber ?? 1) as number;
    tx.set(cRef, { nextNumber: number + 1, nextPriority: c.data()?.nextPriority ?? s.data()!.nextPriority ?? 1 }, { merge: true });
    if (Object.hasOwn(s.data()!, 'nextNumber') || Object.hasOwn(s.data()!, 'nextPriority')) {
      tx.update(sRef, { nextNumber: FieldValue.delete(), nextPriority: FieldValue.delete() });
    }
    tx.set(aRef, {
      uid,
      number,
      priority: false,
      pNumber: null,
      status: 'waiting',
      method,
      by,
      checkedInAt: Timestamp.fromMillis(atMs),
      syncedAt: FieldValue.serverTimestamp(),
      fullName: u.fullName,
      stateCode: u.stateCode,
      photoURL: u.photoURL ?? null,
    });
    return { number, already: false };
  });
}

async function notify(uids: string[], title: string, body: string, link = '/tag', kind = 'alert'): Promise<number> {
  if (!uids.length) return 0;
  const snaps = await db.getAll(...uids.map((u) => userRef(u)));
  const owner = new Map<string, string>();
  snaps.forEach((s) => ((s.data()?.fcmTokens ?? []) as string[]).forEach((t) => owner.set(t, s.id)));
  const tokens = [...owner.keys()];

  let sent = 0;
  try {
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const res = await getMessaging().sendEachForMulticast({
        tokens: chunk,
        // Data-only message: the service worker shows it, so tapping opens /tag.
        data: { title, body, link, kind },
        webpush: { headers: { Urgency: 'high', TTL: '900' } },
      });
      sent += res.successCount;
      await Promise.all(
        res.responses.map((r, idx) => {
          const code = r.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            const t = chunk[idx];
            return userRef(owner.get(t)!).update({ fcmTokens: FieldValue.arrayRemove(t) });
          }
          return null;
        }),
      );
    }
  } catch (err) {
    // Notifications must never break check-in or batch calling.
    console.error('notify failed', err);
  }
  return sent;
}

/** Broadcast an event to every approved member of a CDS group. */
async function notifyApprovedGroup(gid: string, title: string, body: string, link = '/home') {
  const users = await db.collection('users').where('groupId', '==', gid).get();
  const recipients = users.docs.filter((d) => d.data().status === 'approved').map((d) => d.id);
  const sent = await notify(recipients, title, body, link, 'group-event');
  return { sent, members: recipients.length };
}

// ---------------------------------------------------------------- accounts

/** New corps member joins a CDS group with the group's join code. Starts as "pending". */
export const registerMember = onCall(async (req: CallableRequest) => {
  if ((await platformConfig()).signupsPaused) throw fail('unavailable', 'New sign-ups are paused for a short while. Please try again later.');
  const { uid } = signedIn(req);
  const p = await validateProfile(uid, req.data);
  const joinCode = String(req.data?.joinCode ?? '').trim().toUpperCase();
  if (joinCode.length !== 6) throw fail('invalid-argument', 'Enter the 6-character CDS group code.');

  const g = await db.collection('groups').where('joinCode', '==', joinCode).limit(1).get();
  if (g.empty) throw fail('not-found', 'No CDS group with that code. Ask your exco for it.');
  const gid = g.docs[0].id;

  const gRef = groupRef(gid);
  let isMainExco = false;
  let groupName = '';
  await db.runTransaction(async (tx) => {
    const [groupSnap, existingUser] = await Promise.all([tx.get(gRef), tx.get(userRef(uid))]);
    if (!groupSnap.exists) throw fail('not-found', 'That CDS group no longer exists.');
    if (existingUser.exists) throw fail('already-exists', 'This account is already registered with a CDS group.');
    const groupData = groupSnap.data()!;
    groupName = groupData.name as string;
    isMainExco = groupData.mainExcoStateCode === p.stateCode;
    if (isMainExco) {
      const reservationRef = mainExcoReservationRef(p.stateCode);
      const reservation = await tx.get(reservationRef);
      if (!reservation.exists || reservation.data()!.groupId !== gid) {
        throw fail('permission-denied', 'This state code was not appointed as the main exco for this group.');
      }
      if ((groupData.mainExcoUid && groupData.mainExcoUid !== uid) || (reservation.data()!.claimedUid && reservation.data()!.claimedUid !== uid)) {
        throw fail('already-exists', 'The appointed main exco account has already been claimed. Contact the CDS Pass administrator.');
      }
      tx.update(gRef, { mainExcoUid: uid, mainExcoClaimedAt: FieldValue.serverTimestamp() });
      tx.update(reservationRef, { claimedUid: uid, claimedAt: FieldValue.serverTimestamp() });
    }
    const role: Role = isMainExco ? 'exco' : 'member';
    const status = isMainExco ? 'approved' : 'pending';
    tx.set(userRef(uid), {
      ...p,
      groupId: gid,
      role,
      status,
      fcmTokens: [],
      createdAt: FieldValue.serverTimestamp(),
      ...(isMainExco ? { approvedAt: FieldValue.serverTimestamp(), approvedBy: groupData.createdBy } : {}),
    });
  });
  const role: Role = isMainExco ? 'exco' : 'member';
  const status = isMainExco ? 'approved' : 'pending';
  await auth.setCustomUserClaims(uid, { gid, role, approved: isMainExco });
  await log(gid, uid, 'member_registered', { target: uid, stateCode: p.stateCode });
  if (!isMainExco) {
    const excos = await db.collection('users').where('groupId', '==', gid).get();
    await notify(
      excos.docs.filter((d) => d.data().status === 'approved' && d.data().role === 'exco').map((d) => d.id),
      'New member needs approval',
      `${p.fullName} (${p.stateCode}) has requested to join your CDS group.`,
      '/exco/members',
      'member-request',
    );
  }
  return { ok: true, status, role, groupName };
});

/** The platform admin creates groups without replacing their own group membership. */
export const createManagedGroup = onCall(async (req: CallableRequest) => {
  const { uid, adminStateCode } = await platformAdmin(req);
  const name = text(req.data?.group?.name, 'CDS group name', 3, 60);
  const lga = text(req.data?.group?.lga, 'LGA', 2, 60);
  const state = text(req.data?.group?.state, 'State', 2, 40);
  const mainExcoStateCode = normalizeStateCode(req.data?.mainExcoStateCode);
  if (!mainExcoStateCode) throw fail('invalid-argument', 'Enter a valid state code for the new group’s main exco.');
  if (mainExcoStateCode === adminStateCode) {
    throw fail('failed-precondition', 'Use a different state code for this group’s main exco. Your platform admin account stays in its current CDS group.');
  }
  const reservationRef = mainExcoReservationRef(mainExcoStateCode);
  const existingReservation = await reservationRef.get();
  if (existingReservation.exists) throw fail('already-exists', 'That state code is already appointed as a group’s main exco.');
  try {
    const existingAuth = await auth.getUserByEmail(stateCodeToEmail(mainExcoStateCode));
    if ((await userRef(existingAuth.uid).get()).exists) {
      throw fail('already-exists', 'That state code already has a CDS Pass profile. Choose a state code that can join this new group.');
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }

  let joinCode = newJoinCode();
  let uniqueCode = false;
  for (let i = 0; i < 10; i++) {
    const clash = await db.collection('groups').where('joinCode', '==', joinCode).limit(1).get();
    if (clash.empty) { uniqueCode = true; break; }
    joinCode = newJoinCode();
  }
  if (!uniqueCode) throw fail('resource-exhausted', 'Could not create a unique group code. Please try again.');

  const gRef = db.collection('groups').doc();
  await db.runTransaction(async (tx) => {
    const reservation = await tx.get(reservationRef);
    if (reservation.exists) throw fail('already-exists', 'That state code is already appointed as a group’s main exco.');
    tx.create(gRef, {
      name,
      lga,
      state,
      joinCode,
      batchSize: DEFAULT_BATCH_SIZE,
      venue: null,
      createdBy: uid,
      mainExcoUid: null,
      mainExcoStateCode,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(keysRef(gRef.id), { doorSecret: randomBytes(32).toString('hex') });
    tx.create(reservationRef, { groupId: gRef.id, stateCode: mainExcoStateCode, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
  });
  await log(gRef.id, uid, 'group_created', { name });
  return { ok: true, groupId: gRef.id, joinCode, mainExcoStateCode };
});

/** Deprecated endpoint retained to give old clients a safe error instead of replacing an admin profile. */
export const createGroup = onCall(async () => {
  throw fail('failed-precondition', 'Create groups from Exco → Settings using the platform admin account.');
});

/**
 * First-time setup for the platform admin: signs up AND starts their own CDS group in one step,
 * becoming its approved main exco. Without this the admin could never reach Exco → Settings on a
 * fresh database, because every other sign-up needs a group code.
 */
export const registerPlatformAdmin = onCall(async (req: CallableRequest) => {
  const { uid, adminStateCode } = await platformAdmin(req);
  const p = await validateProfile(uid, req.data);
  if (p.stateCode !== adminStateCode) throw fail('permission-denied', 'Only the CDS Pass platform administrator can do this.');
  const name = text(req.data?.group?.name, 'CDS group name', 3, 60);
  const lga = text(req.data?.group?.lga, 'LGA', 2, 60);
  const state = text(req.data?.group?.state, 'State', 2, 40);

  let joinCode = newJoinCode();
  let uniqueCode = false;
  for (let i = 0; i < 10; i++) {
    const clash = await db.collection('groups').where('joinCode', '==', joinCode).limit(1).get();
    if (clash.empty) { uniqueCode = true; break; }
    joinCode = newJoinCode();
  }
  if (!uniqueCode) throw fail('resource-exhausted', 'Could not create a unique group code. Please try again.');

  const gRef = db.collection('groups').doc();
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(userRef(uid));
    if (existing.exists) throw fail('already-exists', 'This account is already registered.');
    tx.create(gRef, {
      name,
      lga,
      state,
      joinCode,
      batchSize: DEFAULT_BATCH_SIZE,
      venue: null,
      createdBy: uid,
      mainExcoUid: uid,
      mainExcoStateCode: p.stateCode,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(keysRef(gRef.id), { doorSecret: randomBytes(32).toString('hex') });
    tx.create(userRef(uid), {
      ...p,
      groupId: gRef.id,
      role: 'exco',
      status: 'approved',
      fcmTokens: [],
      createdAt: FieldValue.serverTimestamp(),
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: uid,
    });
  });
  await auth.setCustomUserClaims(uid, { gid: gRef.id, role: 'exco', approved: true });
  await log(gRef.id, uid, 'group_created', { name });
  return { ok: true, status: 'approved', role: 'exco', groupName: name, joinCode };
});


/** Exco approves (after checking the NYSC ID card) or rejects a pending member. */
export const approveMember = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const approve = req.data?.approve !== false;
  await userRef(uid).update({
    status: approve ? 'approved' : 'rejected',
    approvedBy: e.uid,
    approvedAt: FieldValue.serverTimestamp(),
  });
  await auth.setCustomUserClaims(uid, { gid: e.gid, role: user.role, approved: approve });
  await log(e.gid, e.uid, approve ? 'member_approved' : 'member_rejected', {
    target: uid,
    stateCode: user.stateCode,
  });
  if (approve) {
    await notify([uid], 'CDS membership approved', 'Your CDS group has approved your registration. Open CDS Pass to continue.', '/home', 'member-approved');
  }
  return { ok: true };
});




/** Make someone an exco (or back to member). */
export const setRole = onCall(async (req: CallableRequest) => {
  const e = await mainExco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const role: Role = req.data?.role === 'exco' ? 'exco' : 'member';
  if (uid === e.uid && role !== 'exco') throw fail('failed-precondition', 'You cannot remove yourself as exco.');
  const group = (await groupRef(e.gid).get()).data();
  if (uid === (group?.mainExcoUid ?? group?.createdBy) && role !== 'exco') {
    throw fail('failed-precondition', 'The main exco who created this CDS group cannot be demoted.');
  }
  if (user.status !== 'approved') throw fail('failed-precondition', 'Approve this member first.');
  await userRef(uid).update({ role });
  await auth.setCustomUserClaims(uid, { gid: e.gid, role, approved: true });
  await log(e.gid, e.uid, 'role_changed', { target: uid, role });
  await notify(
    [uid],
    role === 'exco' ? 'You are now a CDS exco' : 'CDS exco access removed',
    role === 'exco' ? 'Your CDS group has given you exco access.' : 'Your CDS group has changed your access to member.',
    '/home',
    'role-changed',
  );
  return { ok: true };
});

/** Exco resets a member's PIN after checking their NYSC ID card. */
export const resetPin = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const pin = String(req.data?.pin ?? '');
  if (!/^\d{6}$/.test(pin)) throw fail('invalid-argument', 'The new PIN must be 6 digits.');
  await auth.updateUser(uid, { password: pin });
  await log(e.gid, e.uid, 'pin_reset', { target: uid, stateCode: user.stateCode });
  await notify([uid], 'Your CDS Pass PIN was reset', 'An exco reset your PIN. Sign in with the new PIN they gave you.', '/login', 'pin-reset');
  return { ok: true };
});

/** Batch size and venue location. */
export const updateGroupSettings = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const patch: Record<string, unknown> = {};
  if (req.data?.batchSize != null) {
    const n = Number(req.data.batchSize);
    if (!Number.isInteger(n) || n < 5 || n > 100) throw fail('invalid-argument', 'Batch size must be 5–100.');
    patch.batchSize = n;
  }
  if (req.data?.clearVenue) patch.venue = null;
  if (req.data?.venue) {
    const lat = Number(req.data.venue.lat);
    const lng = Number(req.data.venue.lng);
    const radiusM = Number(req.data.venue.radiusM ?? DEFAULT_RADIUS_M);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw fail('invalid-argument', 'Invalid location.');
    if (!(radiusM >= 50 && radiusM <= 2000)) throw fail('invalid-argument', 'Radius must be 50–2000 m.');
    patch.venue = { lat, lng, radiusM };
  }
  if (!Object.keys(patch).length) return { ok: true };
  await groupRef(e.gid).update(patch);
  await log(e.gid, e.uid, 'settings_changed', { patch });
  if ('venue' in patch) {
    const venueMessage = patch.venue
      ? `Venue location checking is on. You must be near the CDS venue to scan in (within ${(patch.venue as { radiusM: number }).radiusM} metres).`
      : 'Venue location checking has been turned off for your CDS group.';
    await notifyApprovedGroup(e.gid, 'CDS venue settings updated', venueMessage, '/home');
  }
  return { ok: true };
});

// ---------------------------------------------------------------- CDS day

export const startSession = onCall(async (req: CallableRequest) => {
  await assertGroupActive((req.auth?.token?.gid as string) ?? '');
  const e = await exco(req);
  const sid = lagosDate();
  const ref = sessionRef(e.gid, sid);
  const counter = sessionCounterRef(e.gid, sid);
  await db.runTransaction(async (tx) => {
    const [session, counts] = await Promise.all([tx.get(ref), tx.get(counter)]);
    const previous = session.data();
    if (!counts.exists) {
      tx.set(counter, {
        nextNumber: previous?.nextNumber ?? 1,
        nextPriority: previous?.nextPriority ?? 1,
      });
    }
    if (session.exists) {
      tx.update(ref, {
        status: 'open',
        reopenedAt: FieldValue.serverTimestamp(),
        nextNumber: FieldValue.delete(),
        nextPriority: FieldValue.delete(),
      });
    } else {
      tx.set(ref, {
        status: 'open',
        openedAt: FieldValue.serverTimestamp(),
        openedBy: e.uid,
        lastTo: 0,
        batchSeq: 0,
        batch: null,
      });
    }
  });
  await log(e.gid, e.uid, 'session_opened', { sessionId: sid });
  await notifyApprovedGroup(e.gid, "Today's CDS meeting is open", 'The meeting is open. Scan the door code at the venue to check in.', '/home');
  return { ok: true, sessionId: sid };
});

export const endSession = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const sid = lagosDate();
  await sessionRef(e.gid, sid).update({ status: 'closed', closedAt: FieldValue.serverTimestamp() });
  await log(e.gid, e.uid, 'session_closed', { sessionId: sid });
  await notifyApprovedGroup(e.gid, "Today's CDS meeting has ended", 'The exco has ended the meeting. Batch calls are stopped.', '/home');
  return { ok: true };
});

/** The exco's door screen asks for a fresh code every ~25 seconds. */
export const getDoorCode = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const sid = lagosDate();
  const s = await sessionRef(e.gid, sid).get();
  if (!s.exists || s.data()!.status !== 'open') {
    throw fail('failed-precondition', "Open today's CDS meeting first.");
  }
  const secret = (await keysRef(e.gid).get()).data()?.doorSecret as string;
  const epoch = Number(s.data()!.doorEpoch ?? 0);
  const now = Date.now();
  const w = Math.floor(now / WINDOW_MS);
  return { code: doorCode(secret, e.gid, sid, w, epoch), gid: e.gid, sessionId: sid, epoch, expiresAt: (w + 1) * WINDOW_MS };
});

/**
 * A member scans the door QR (or types the 6-digit code).
 * `scannedAt` is set when the scan was saved offline and is being sent later.
 */
export const checkIn = onCall(async (req: CallableRequest) => {
  const { uid, gid } = approvedMember(req);
  const code = String(req.data?.code ?? '').replace(/\D/g, '');
  if (code.length !== 6) throw fail('invalid-argument', 'Enter the 6-digit code on the exco screen.');
  if (req.data?.gid && req.data.gid !== gid) {
    throw fail('permission-denied', 'That code belongs to a different CDS group.');
  }

  const now = Date.now();
  const offline = req.data?.scannedAt != null;
  let at = now;
  if (offline) {
    const t = Number(req.data.scannedAt);
    if (!Number.isFinite(t) || t > now + 60_000 || t < now - 6 * 3600_000) {
      throw fail('invalid-argument', 'This saved scan is too old. Please scan again.');
    }
    at = Math.min(t, now);
  }
  const sid = lagosDate(at);

  const [g, keys, sess] = await Promise.all([groupRef(gid).get(), keysRef(gid).get(), sessionRef(gid, sid).get()]);
  const secret = keys.data()?.doorSecret as string | undefined;
  if (!secret) throw fail('internal', 'Group is not set up correctly.');

  const w = Math.floor(at / WINDOW_MS);
  const epoch = Number(sess.data()?.doorEpoch ?? 0);
  // Live scans must match the current door code. Saved (offline) scans may be from before a reset.
  const epochs = offline ? Array.from({ length: Math.min(epoch, 20) + 1 }, (_, i) => epoch - i) : [epoch];
  if (!epochs.some((ep) => [w, w - 1].some((x) => doorCode(secret, gid, sid, x, ep) === code))) {
    throw fail('invalid-argument', 'That code has expired. Scan the code on the exco screen again.');
  }

  const venue = g.data()?.venue as { lat: number; lng: number; radiusM?: number } | null;
  if (venue) {
    const lat = Number(req.data?.lat);
    const lng = Number(req.data?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw fail('failed-precondition', 'Turn on location so we can confirm you are at the CDS venue.');
    }
    if (distanceM(lat, lng, venue.lat, venue.lng) > (venue.radiusM ?? DEFAULT_RADIUS_M)) {
      throw fail('failed-precondition', 'You need to be at the CDS venue to check in.');
    }
  }

  const r = await admit(gid, sid, uid, offline ? 'offline' : 'self', uid, at);
  return { ...r, sessionId: sid };
});

/** Exco looks someone up (scanned tag/card or typed state code) to see their photo first. */
export const lookupMember = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const a = await attendeeRef(e.gid, lagosDate(), uid).get();
  return { member: publicMember(uid, user), attendee: a.exists ? a.data() : null };
});

/** Exco checks in someone without a working phone (printed card, or manual by state code). */
export const excoCheckIn = onCall(async (req: CallableRequest) => {
  const method = req.data?.method === 'card' ? 'card' : 'manual';
  // Printed cards: any exco at the door. Typing a state code by hand: main exco only (use giveNextNumber).
  const e = method === 'card' ? await exco(req) : await mainExco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const r = await admit(e.gid, lagosDate(), uid, method, e.uid, Date.now());
  if (!r.already && method === 'manual') {
    await log(e.gid, e.uid, 'manual_checkin', { target: uid, stateCode: user.stateCode, number: r.number });
  }
  return { ...r, member: publicMember(uid, user) };
});

/**
 * Main exco gives a registered member the next number by hand (phone off, flat battery …).
 * Afterwards the door code changes immediately, so nobody can reuse the code that was on screen.
 */
export const giveNextNumber = onCall(async (req: CallableRequest) => {
  const e = await mainExco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const sid = lagosDate();
  const r = await admit(e.gid, sid, uid, 'manual', e.uid, Date.now());
  await sessionRef(e.gid, sid).update({ doorEpoch: FieldValue.increment(1), doorResetAt: FieldValue.serverTimestamp() });
  if (!r.already) {
    await log(e.gid, e.uid, 'manual_checkin', { target: uid, stateCode: user.stateCode, number: r.number });
    await notify([uid], `Your number is ${r.number}`, `${e.name} checked you in at the door. Your number is ${r.number}.`, '/tag', 'checkin');
  }
  return { ...r, member: publicMember(uid, user) };
});

/** Pregnant and nursing mothers get a priority tag (P1, P2 …). The reason is never stored. */
export const setPriority = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const sid = lagosDate();
  const pNumber = await db.runTransaction(async (tx) => {
    const sRef = sessionRef(e.gid, sid);
    const aRef = attendeeRef(e.gid, sid, uid);
    const cRef = sessionCounterRef(e.gid, sid);
    const [s, a, c] = await Promise.all([tx.get(sRef), tx.get(aRef), tx.get(cRef)]);
    if (!s.exists || s.data()!.status !== 'open') throw fail('failed-precondition', "Open today's CDS meeting first.");
    if (!a.exists) throw fail('failed-precondition', 'Check this person in first.');
    if (a.data()!.priority) return a.data()!.pNumber as number;
    const n = (c.data()?.nextPriority ?? s.data()!.nextPriority ?? 1) as number;
    tx.set(cRef, { nextNumber: c.data()?.nextNumber ?? s.data()!.nextNumber ?? 1, nextPriority: n + 1 }, { merge: true });
    if (Object.hasOwn(s.data()!, 'nextNumber') || Object.hasOwn(s.data()!, 'nextPriority')) {
      tx.update(sRef, { nextNumber: FieldValue.delete(), nextPriority: FieldValue.delete() });
    }
    tx.update(aRef, { priority: true, pNumber: n, priorityBy: e.uid });
    return n;
  });
  await log(e.gid, e.uid, 'priority_given', { target: uid, stateCode: user.stateCode, pNumber });
  return { ok: true, pNumber };
});

/** "Call priority" or "Call next batch". Notifies everyone in the batch. */
export const callNext = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const sid = lagosDate();
  const mode = req.data?.mode === 'priority' ? 'priority' : 'next';
  const g = await groupRef(e.gid).get();
  const size = (g.data()?.batchSize as number) ?? DEFAULT_BATCH_SIZE;

  const batch = await db.runTransaction(async (tx) => {
    const sRef = sessionRef(e.gid, sid);
    const cRef = sessionCounterRef(e.gid, sid);
    const [s, c] = await Promise.all([tx.get(sRef), tx.get(cRef)]);
    if (!s.exists || s.data()!.status !== 'open') throw fail('failed-precondition', "Open today's CDS meeting first.");
    const d = s.data()!;
    const seq = (d.batchSeq as number) + 1;
    let b: Batch;
    if (mode === 'priority') {
      if (((c.data()?.nextPriority ?? d.nextPriority ?? 1) as number) <= 1) throw fail('failed-precondition', 'Nobody has a priority tag yet.');
      b = { kind: 'priority', seq };
    } else {
      const from = (d.lastTo as number) + 1;
      if (from > ((c.data()?.nextNumber ?? d.nextNumber ?? 1) as number) - 1) {
        throw fail('failed-precondition', `Nobody has checked in beyond No. ${from - 1} yet.`);
      }
      b = { kind: 'regular', seq, from, to: from + size - 1 };
      tx.update(sRef, { lastTo: b.to });
    }
    tx.update(sRef, { batch: { ...b, calledAt: FieldValue.serverTimestamp() }, batchSeq: seq });
    return b;
  });

  const waiting = await db
    .collection(`groups/${e.gid}/sessions/${sid}/attendees`)
    .where('status', '==', 'waiting')
    .get();
  const targets = waiting.docs
    .filter((d) => {
      const a = d.data();
      return batch.kind === 'priority' ? a.priority === true : !a.priority && a.number >= batch.from && a.number <= batch.to;
    })
    .map((d) => d.id);

  const label = batch.kind === 'priority' ? 'Priority' : `No. ${batch.from} – ${batch.to}`;
  const latest = await sessionRef(e.gid, sid).get();
  if (!latest.exists || latest.data()!.status !== 'open' || latest.data()!.batchSeq !== batch.seq) {
    throw fail('failed-precondition', 'The meeting ended before this batch could be called. No alerts were sent.');
  }
  const sent = await notify(targets, `${label}: it's your turn`, 'Go to the thumbprint table now and show your CDS Pass tag.', '/tag', 'batch-call');
  await log(e.gid, e.uid, 'batch_called', { label, notified: sent });
  return { ok: true, batch, notified: sent, inBatch: targets.length };
});

/** Main exco only: sends a test push to every approved member of the group who has alerts turned on. */
export const testNotification = onCall(async (req: CallableRequest) => {
  const e = await mainExco(req);
  const members = await db.collection('users').where('groupId', '==', e.gid).get();
  const targets = members.docs
    .filter((d) => d.data().status === 'approved' && Array.isArray(d.data().fcmTokens) && d.data().fcmTokens.length > 0)
    .map((d) => d.id);
  const registered = members.docs.filter((d) => d.data().status === 'approved').length;
  if (!targets.length) return { sent: 0, registered: 0, members: registered };
  const sent = await notify(
    targets,
    'CDS Pass test notification',
    `${e.name} sent a test notification for your CDS group.`,
    '/home',
    'group-test',
  );
  await log(e.gid, e.uid, 'notification_test', { notified: sent, targetMembers: targets.length });
  return { sent, registered: targets.length, members: registered };
});

const MESSAGES_PER_DAY = 5;
const MESSAGE_LINKS = new Set(['/home', '/dues', '/tag', '/scan']);
type Audience = 'all' | 'unpaid' | 'pending' | 'excos';

/**
 * Main exco sends their own push message ("Good morning corpers", "Job alert" …) to a chosen group of
 * members. Limited to 5 a day per CDS group so people don't switch notifications off.
 */
export const sendGroupMessage = onCall(async (req: CallableRequest) => {
  const e = await mainExco(req);
  const title = text(req.data?.title, 'Title', 3, 60);
  const body = text(req.data?.body, 'Message', 3, 300);
  const audience: Audience = ['all', 'unpaid', 'pending', 'excos'].includes(req.data?.audience) ? req.data.audience : 'all';
  const link = MESSAGE_LINKS.has(req.data?.link) ? (req.data.link as string) : '/home';

  const day = lagosDate();
  const counterRef = db.doc(`groups/${e.gid}/private/messages-${day}`);
  const used = Number((await counterRef.get()).data()?.count ?? 0);
  if (used >= MESSAGES_PER_DAY) {
    throw fail('resource-exhausted', `You can send ${MESSAGES_PER_DAY} messages a day. Try again tomorrow.`);
  }

  const members = await db.collection('users').where('groupId', '==', e.gid).get();
  let targets = members.docs.filter((d) => (audience === 'pending' ? d.data().status === 'pending' : d.data().status === 'approved'));
  if (audience === 'excos') targets = targets.filter((d) => d.data().role === 'exco');
  if (audience === 'unpaid') {
    const open = await db.collection(`groups/${e.gid}/dues`).where('active', '==', true).get();
    if (open.empty) throw fail('failed-precondition', 'There are no open dues, so nobody is "not paid".');
    const owing = new Set<string>();
    for (const d of open.docs) (await owingMembers(e.gid, d.id)).forEach((u) => owing.add(u));
    targets = targets.filter((d) => owing.has(d.id));
  }
  const uids = targets.map((d) => d.id);
  if (!uids.length) throw fail('failed-precondition', 'Nobody matches that choice right now.');

  const sent = await notify(uids, title, body, link, 'message');
  await counterRef.set({ count: FieldValue.increment(1) }, { merge: true });
  await db.collection(`groups/${e.gid}/messages`).add({
    title,
    body,
    audience,
    link,
    recipients: uids.length,
    delivered: sent,
    sentBy: e.uid,
    sentByName: e.name,
    sentAt: FieldValue.serverTimestamp(),
  });
  await log(e.gid, e.uid, 'message_sent', { label: title, notified: sent });
  return { ok: true, recipients: uids.length, delivered: sent, left: MESSAGES_PER_DAY - used - 1 };
});

/** History of sent messages (main exco). */
export const listGroupMessages = onCall(async (req: CallableRequest) => {
  const e = await mainExco(req);
  const snap = await db.collection(`groups/${e.gid}/messages`).orderBy('sentAt', 'desc').limit(30).get();
  const used = Number((await db.doc(`groups/${e.gid}/private/messages-${lagosDate()}`).get()).data()?.count ?? 0);
  return {
    left: Math.max(0, MESSAGES_PER_DAY - used),
    messages: snap.docs.map((d) => {
      const m = d.data();
      return { id: d.id, title: m.title, body: m.body, audience: m.audience, recipients: m.recipients, delivered: m.delivered, sentByName: m.sentByName, sentAt: m.sentAt?.toMillis?.() ?? null };
    }),
  };
});

/** Exco scans a tag at the thumbprint table. Green = thumbprint, red = wait. */
export const tableCheck = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const sid = lagosDate();
  const [s, a] = await Promise.all([sessionRef(e.gid, sid).get(), attendeeRef(e.gid, sid, uid).get()]);
  const batch = (s.data()?.batch ?? null) as Batch | null;
  const member = publicMember(uid, user);

  if (!a.exists) {
    await log(e.gid, e.uid, 'table_refused', { target: uid, reason: 'not_checked_in' });
    return { result: 'not_checked_in', member, batch };
  }
  const att = a.data()!;
  const base = { member, batch, number: att.number, priority: !!att.priority, pNumber: att.pNumber ?? null };
  if (att.status === 'done') {
    await log(e.gid, e.uid, 'table_refused', { target: uid, reason: 'already_done' });
    return { ...base, result: 'already_done', doneAt: att.doneAt?.toMillis?.() ?? null };
  }
  if (!batch) return { ...base, result: 'not_started' };
  if (!isTurn({ number: att.number, priority: att.priority, status: att.status }, batch)) {
    await log(e.gid, e.uid, 'table_refused', { target: uid, reason: 'not_turn', number: att.number });
    return { ...base, result: 'not_turn' };
  }
  return { ...base, result: 'your_turn' };
});

/** After the LGI thumbprints them, the exco taps Done. The tag can never be used again today. */
export const markDone = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const sid = lagosDate();
  await db.runTransaction(async (tx) => {
    const sRef = sessionRef(e.gid, sid);
    const aRef = attendeeRef(e.gid, sid, uid);
    const [s, a] = await Promise.all([tx.get(sRef), tx.get(aRef)]);
    if (!a.exists) throw fail('failed-precondition', 'This person has not checked in today.');
    const att = a.data()!;
    if (att.status === 'done') throw fail('already-exists', 'Already thumbprinted today.');
    if (!isTurn({ number: att.number, priority: att.priority, status: att.status }, s.data()?.batch)) {
      throw fail('failed-precondition', 'It is not this person’s turn yet.');
    }
    tx.update(aRef, { status: 'done', doneAt: FieldValue.serverTimestamp(), doneBy: e.uid });
  });
  await log(e.gid, e.uid, 'thumbprinted', { target: uid, stateCode: user.stateCode });
  return { ok: true };
});


// ================================================================ DUES

/** Paystack secret key: PAYSTACK_SECRET_KEY in server/.env (local) or Render → Environment (live). */
const paystackSecret = defineSecret('PAYSTACK_SECRET_KEY');
/** Online charges added on top of dues (see duesCharges in shared.ts). */
const SERVICE_FEE_PERCENT = Number(process.env.SERVICE_FEE_PERCENT ?? 3);
const PAYSTACK_FEE_PERCENT = Number(process.env.PAYSTACK_FEE_PERCENT ?? 1.5);

const duesRef = (gid: string, duesId: string) => db.doc(`groups/${gid}/dues/${duesId}`);
const duesStatusRef = (gid: string, duesId: string, uid: string) => db.doc(`groups/${gid}/dues/${duesId}/status/${uid}`);
const paymentRef = (gid: string, ref: string) => db.doc(`groups/${gid}/payments/${ref}`);
const payoutRef = (gid: string) => db.doc(`groups/${gid}/private/payout`);

function paystackKey(): string {
  let key = '';
  try {
    key = paystackSecret.value();
  } catch {
    /* not set */
  }
  if (!key) throw fail('failed-precondition', 'Online payments are not set up yet. Ask the developer to add the Paystack key.');
  return key;
}

async function paystack<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${paystackKey()}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
  if (!res.ok || json.status === false) {
    throw fail('failed-precondition', json.message || `Paystack error (${res.status})`);
  }
  return json.data as T;
}

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

/** Marks a dues as paid for a member (idempotent). */
async function settle(gid: string, reference: string, paidKobo: number) {
  const pRef = paymentRef(gid, reference);
  return db.runTransaction(async (tx) => {
    const p = await tx.get(pRef);
    if (!p.exists) throw fail('not-found', 'Payment not found.');
    const pay = p.data()!;
    if (pay.status === 'paid') return pay;
    if (paidKobo < pay.totalKobo) throw fail('failed-precondition', 'Amount paid does not match.');
    tx.update(pRef, { status: 'paid', paidAt: FieldValue.serverTimestamp() });
    tx.set(duesStatusRef(gid, pay.duesId, pay.uid), {
      uid: pay.uid,
      status: 'paid',
      method: 'online',
      amountKobo: pay.amountKobo,
      reference,
      paidAt: FieldValue.serverTimestamp(),
      fullName: pay.fullName,
      stateCode: pay.stateCode,
    });
    return { ...pay, status: 'paid' };
  });
}

/** Bank list for the exco's "where should dues go" form. */
export const listBanks = onCall({ secrets: [paystackSecret] }, async (req: CallableRequest) => {
  await exco(req);
  const banks = await paystack<{ name: string; code: string; active: boolean }[]>('/bank?country=nigeria&perPage=200');
  return banks.filter((b) => b.active).map((b) => ({ name: b.name, code: b.code }));
});

/** Shows the account name before saving, so the wrong account isn't used. */
export const resolveAccount = onCall({ secrets: [paystackSecret] }, async (req: CallableRequest) => {
  await exco(req);
  const acct = String(req.data?.accountNumber ?? '').replace(/\D/g, '');
  const bank = String(req.data?.bankCode ?? '');
  if (acct.length !== 10 || !bank) throw fail('invalid-argument', 'Enter a 10-digit account number and choose the bank.');
  const r = await paystack<{ account_name: string }>(`/bank/resolve?account_number=${acct}&bank_code=${encodeURIComponent(bank)}`);
  return { accountName: r.account_name };
});

/** Saves the group's dues account as a Paystack subaccount (created once, updated on handover). */
export const setPayoutAccount = onCall({ secrets: [paystackSecret] }, async (req: CallableRequest) => {
  const e = await exco(req);
  const acct = String(req.data?.accountNumber ?? '').replace(/\D/g, '');
  const bankCode = String(req.data?.bankCode ?? '');
  const bankName = text(req.data?.bankName, 'Bank', 2, 80);
  if (acct.length !== 10 || !bankCode) throw fail('invalid-argument', 'Enter a 10-digit account number and choose the bank.');

  const { account_name } = await paystack<{ account_name: string }>(
    `/bank/resolve?account_number=${acct}&bank_code=${encodeURIComponent(bankCode)}`,
  );
  const g = (await groupRef(e.gid).get()).data()!;
  const existing = (await payoutRef(e.gid).get()).data();
  const body = {
    business_name: `CDS Pass · ${g.name}`.slice(0, 100),
    settlement_bank: bankCode,
    account_number: acct,
    percentage_charge: 0,
    description: `${g.name}, ${g.lga} (${e.gid})`,
  };
  const sub = existing?.subaccountCode
    ? await paystack<{ subaccount_code: string }>(`/subaccount/${existing.subaccountCode}`, { method: 'PUT', body })
    : await paystack<{ subaccount_code: string }>('/subaccount', { method: 'POST', body });

  await payoutRef(e.gid).set({ subaccountCode: sub.subaccount_code ?? existing?.subaccountCode, updatedAt: FieldValue.serverTimestamp() });
  await groupRef(e.gid).update({
    payout: { bankName, accountName: account_name, last4: acct.slice(-4), setBy: e.uid, setAt: FieldValue.serverTimestamp() },
  });
  await log(e.gid, e.uid, 'payout_account_set', { label: `${bankName} ****${acct.slice(-4)} (${account_name})` });
  await notifyApprovedGroup(e.gid, 'CDS dues account updated', 'Your group has updated the account used for CDS dues. Check the Dues page before making a payment.', '/dues');
  return { ok: true, accountName: account_name };
});

/** Exco creates a dues item, e.g. "November dues ₦1,000". */
export const createDues = onCall(async (req: CallableRequest) => {
  const e = await mainExco(req);
  const title = text(req.data?.title, 'Title', 3, 60);
  const amount = Number(req.data?.amountNaira);
  if (!Number.isFinite(amount) || amount < 50 || amount > 100_000) throw fail('invalid-argument', 'Amount must be ₦50 – ₦100,000.');
  const dueDate = typeof req.data?.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.data.dueDate) ? req.data.dueDate : null;
  const requiredForCheckIn = req.data?.requiredForCheckIn === true;
  if (requiredForCheckIn && !dueDate) throw fail('invalid-argument', 'Choose the collection date, so members know when they must pay.');
  if (dueDate && dueDate < lagosDate()) throw fail('invalid-argument', 'The collection date cannot be in the past.');
  const ref = db.collection(`groups/${e.gid}/dues`).doc();
  await ref.set({
    title,
    amountKobo: Math.round(amount * 100),
    dueDate,
    requiredForCheckIn,
    remindersSent: {},
    active: true,
    createdBy: e.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  await log(e.gid, e.uid, 'dues_created', { label: `${title} · ${naira(Math.round(amount * 100))}` });
  await notifyApprovedGroup(
    e.gid,
    `New CDS dues: ${title}`,
    `${naira(Math.round(amount * 100))}${dueDate ? ` · collection on ${prettyDate(dueDate)}` : ''}.${
      requiredForCheckIn ? ' You must pay before you can get a number that day.' : ''
    } Pay online in CDS Pass or pay cash to an exco.`,
    '/dues',
  );
  return { ok: true, duesId: ref.id };
});

export const closeDues = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const duesId = String(req.data?.duesId ?? '');
  const ref = duesRef(e.gid, duesId);
  const dues = await ref.get();
  if (!dues.exists) throw fail('not-found', 'Those dues could not be found.');
  await ref.update({ active: false, closedAt: FieldValue.serverTimestamp() });
  await log(e.gid, e.uid, 'dues_closed', { duesId });
  await notifyApprovedGroup(e.gid, 'CDS dues closed', `${String(dues.data()!.title)} is now closed.`, '/dues');
  return { ok: true };
});

/** Member starts an online payment. Returns the Paystack checkout link. */
export const startPayment = onCall({ secrets: [paystackSecret] }, async (req: CallableRequest) => {
  if ((await platformConfig()).paymentsPaused) throw fail('unavailable', 'Online payments are paused for a short while. You can pay cash to an exco.');
  await assertGroupActive((req.auth?.token?.gid as string) ?? '');
  const { uid, gid } = approvedMember(req);
  const duesId = String(req.data?.duesId ?? '');
  const returnUrl = String(req.data?.returnUrl ?? '');
  if (!/^(https:\/\/|http:\/\/localhost|http:\/\/127\.0\.0\.1)/.test(returnUrl)) throw fail('invalid-argument', 'Invalid return address.');

  const [d, st, u, payout] = await Promise.all([
    duesRef(gid, duesId).get(),
    duesStatusRef(gid, duesId, uid).get(),
    userRef(uid).get(),
    payoutRef(gid).get(),
  ]);
  if (!d.exists || !d.data()!.active) throw fail('not-found', 'These dues are no longer open.');
  if (st.data()?.status === 'paid') throw fail('already-exists', 'You have already paid these dues.');
  const subaccount = payout.data()?.subaccountCode as string | undefined;
  if (!subaccount) throw fail('failed-precondition', 'Your excos have not added the CDS bank account yet.');

  const amountKobo = d.data()!.amountKobo as number;
  const { serviceKobo, paystackKobo, chargesKobo, totalKobo } = duesCharges(amountKobo, SERVICE_FEE_PERCENT, PAYSTACK_FEE_PERCENT);
  const feeKobo = serviceKobo;
  const reference = `cds-${gid}-${randomBytes(6).toString('hex')}`;
  const user = u.data()!;

  await paymentRef(gid, reference).set({
    reference,
    uid,
    duesId,
    duesTitle: d.data()!.title,
    amountKobo,
    feeKobo,
    paystackKobo,
    totalKobo,
    method: 'online',
    status: 'pending',
    fullName: user.fullName,
    stateCode: user.stateCode,
    createdAt: FieldValue.serverTimestamp(),
  });

  const init = await paystack<{ authorization_url: string }>('/transaction/initialize', {
    method: 'POST',
    body: {
      email: stateCodeToEmail(user.stateCode),
      amount: totalKobo,
      reference,
      callback_url: `${returnUrl.replace(/\/$/, '')}/dues?reference=${reference}`,
      subaccount,
      // Your 3% + the 1.5% for Paystack go to the main (CDS Pass) account; Paystack takes its
      // charge from that share, so the group's subaccount gets exactly the dues.
      transaction_charge: chargesKobo,
      bearer: 'account',
      channels: ['card', 'bank_transfer', 'ussd', 'bank'],
      metadata: { gid, uid, duesId, stateCode: user.stateCode },
    },
  });
  return { authorizationUrl: init.authorization_url, reference, totalKobo };
});

/** Called when the member returns from Paystack. Safe to call more than once. */
export const verifyPayment = onCall({ secrets: [paystackSecret] }, async (req: CallableRequest) => {
  const { uid, gid } = approvedMember(req);
  const reference = String(req.data?.reference ?? '');
  const p = await paymentRef(gid, reference).get();
  if (!p.exists || p.data()!.uid !== uid) throw fail('not-found', 'Payment not found.');
  if (p.data()!.status === 'paid') return { status: 'paid' };
  const v = await paystack<{ status: string; amount: number }>(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (v.status !== 'success') return { status: v.status };
  await settle(gid, reference, v.amount);
  return { status: 'paid' };
});

/**
 * Paystack webhook: marks payments as paid even if the member closed the app before returning.
 * Set https://<your-render-app>.onrender.com/paystack/webhook in Paystack → Settings → API Keys & Webhooks.
 */
export const paystackWebhook = onRequest({ secrets: [paystackSecret] }, async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const expected = createHmac('sha512', paystackKey()).update(req.rawBody).digest('hex');
  if (typeof sig !== 'string' || sig !== expected) {
    res.status(401).send('bad signature');
    return;
  }
  const event = req.body as { event?: string; data?: { reference?: string; amount?: number; status?: string } };
  const ref = event.data?.reference ?? '';
  const m = ref.match(/^cds-([A-Za-z0-9]+)-[a-f0-9]+$/);
  if (event.event === 'charge.success' && m && event.data?.status === 'success') {
    try {
      await settle(m[1], ref, event.data.amount ?? 0);
    } catch (err) {
      console.error('webhook settle failed', ref, err);
    }
  }
  res.status(200).send('ok');
});

/** Treasurer records cash. The member must confirm it on their phone before it counts. */
export const recordCash = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const duesId = String(req.data?.duesId ?? '');
  const d = await duesRef(e.gid, duesId).get();
  if (!d.exists) throw fail('not-found', 'Dues not found.');
  const st = await duesStatusRef(e.gid, duesId, uid).get();
  if (st.data()?.status === 'paid') throw fail('already-exists', `${user.fullName} has already paid.`);

  // Cash counts straight away (so they can get a number at the door). The member is told who recorded
  // it and can tap "This is wrong"; every record is in the activity log.
  const reference = `cash-${e.gid}-${randomBytes(6).toString('hex')}`;
  const amountKobo = d.data()!.amountKobo as number;
  const batch = db.batch();
  batch.set(paymentRef(e.gid, reference), {
    reference,
    uid,
    duesId,
    duesTitle: d.data()!.title,
    amountKobo,
    feeKobo: 0,
    totalKobo: amountKobo,
    method: 'cash',
    status: 'paid',
    recordedBy: e.uid,
    recordedByName: e.name,
    fullName: user.fullName,
    stateCode: user.stateCode,
    createdAt: FieldValue.serverTimestamp(),
    paidAt: FieldValue.serverTimestamp(),
  });
  batch.set(duesStatusRef(e.gid, duesId, uid), {
    uid,
    status: 'paid',
    method: 'cash',
    amountKobo,
    reference,
    recordedBy: e.uid,
    recordedByName: e.name,
    fullName: user.fullName,
    stateCode: user.stateCode,
    recordedAt: FieldValue.serverTimestamp(),
    paidAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  await log(e.gid, e.uid, 'cash_recorded', { target: uid, stateCode: user.stateCode, label: `${d.data()!.title} · ${naira(amountKobo)}` });
  const time = new Date().toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });
  await notify(
    [uid],
    `${naira(amountKobo)} cash recorded`,
    `${e.name} recorded your cash payment for ${d.data()!.title} at ${time}. If this is wrong, open Dues and tap "This is wrong".`,
    '/dues',
    'cash',
  );
  return { ok: true };
});

/**
 * Member flags a cash record as wrong ("I didn't pay this"). It stops counting as paid, the main exco
 * is alerted, and it goes in the activity log. (confirm:true is still accepted from older app versions.)
 */
export const respondCash = onCall(async (req: CallableRequest) => {
  const { uid, gid } = approvedMember(req);
  const duesId = String(req.data?.duesId ?? '');
  const confirm = req.data?.confirm === true;
  const sRef = duesStatusRef(gid, duesId, uid);
  const st = await sRef.get();
  const s0 = st.data();
  if (!s0 || s0.method !== 'cash' || (s0.status !== 'cash_pending' && s0.status !== 'paid')) {
    throw fail('failed-precondition', 'There is no cash record to respond to.');
  }
  const reference = s0.reference as string;
  const batch = db.batch();
  if (confirm) {
    batch.update(sRef, { status: 'paid', paidAt: FieldValue.serverTimestamp() });
    batch.update(paymentRef(gid, reference), { status: 'paid', paidAt: FieldValue.serverTimestamp() });
  } else {
    batch.update(sRef, { status: 'disputed', disputedAt: FieldValue.serverTimestamp() });
    batch.update(paymentRef(gid, reference), { status: 'disputed', disputedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  await log(gid, uid, confirm ? 'cash_confirmed' : 'cash_disputed', { target: uid, reference, label: s0.recordedByName });
  if (!confirm) {
    const g = (await groupRef(gid).get()).data();
    const main = (g?.mainExcoUid ?? g?.createdBy) as string | undefined;
    const who = (await userRef(uid).get()).data();
    if (main) {
      await notify(
        [main],
        'Cash record disputed',
        `${who?.fullName ?? 'A member'} says they did not pay the cash ${s0.recordedByName ?? 'an exco'} recorded. Check Dues.`,
        '/exco/dues',
        'dispute',
      );
    }
  }
  return { ok: true };
});

/** Approved members of a group who haven't paid these dues. */
async function owingMembers(gid: string, duesId: string) {
  const [members, statuses] = await Promise.all([
    db.collection('users').where('groupId', '==', gid).get(),
    db.collection(`groups/${gid}/dues/${duesId}/status`).get(),
  ]);
  const paid = new Set(statuses.docs.filter((s) => s.data().status === 'paid').map((s) => s.id));
  return members.docs.filter((m) => m.data().status === 'approved' && !paid.has(m.id)).map((m) => m.id);
}

const prettyDate = (ymd: string) =>
  new Date(`${ymd}T12:00:00+01:00`).toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });

/**
 * Automatic dues reminders. Called by cron-job.org (GET /cron/reminders?key=CRON_SECRET), e.g. at 18:00
 * and 07:00 Lagos time. Evening run: dues collected TOMORROW. Morning run: dues collected TODAY.
 * Each reminder is sent once per dues per slot, so extra calls are harmless.
 */
export async function runDuesReminders(now = Date.now()) {
  const today = lagosDate(now);
  const tomorrow = lagosDate(now + 24 * 3600_000);
  const hour = Number(new Date(now).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Lagos' }));
  const evening = hour >= 12;
  const target = evening ? tomorrow : today;
  const slot = `${target}:${evening ? 'eve' : 'morning'}`;
  let reminded = 0;
  const groups = await db.collection('groups').get();
  for (const g of groups.docs) {
    const open = await db.collection(`groups/${g.id}/dues`).where('active', '==', true).get();
    for (const d of open.docs) {
      const dues = d.data();
      if (dues.dueDate !== target || dues.remindersSent?.[slot]) continue;
      const owing = await owingMembers(g.id, d.id);
      const amount = naira(dues.amountKobo);
      const title = evening ? `Dues collection tomorrow: ${amount}` : `Dues collection today: ${amount}`;
      const body = `${dues.title}. ${
        dues.requiredForCheckIn ? 'You must pay before you can get a number. ' : ''
      }Pay online in CDS Pass now, or pay cash to an exco.`;
      const sent = await notify(owing, title, body, '/dues', 'dues-reminder');
      await d.ref.update({ [`remindersSent.${slot}`]: FieldValue.serverTimestamp() });
      await log(g.id, 'system', 'dues_reminder', { label: `${dues.title} (${evening ? 'evening before' : 'morning'})`, notified: sent });
      reminded += owing.length;
    }
  }
  return { slot, reminded };
}

/** Buzz everyone who hasn't paid yet. */
export const remindDues = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const duesId = String(req.data?.duesId ?? '');
  const d = await duesRef(e.gid, duesId).get();
  if (!d.exists) throw fail('not-found', 'Dues not found.');
  const owing = await owingMembers(e.gid, duesId);
  const sent = await notify(owing, `${d.data()!.title}: ${naira(d.data()!.amountKobo)}`, 'Tap to pay your CDS dues in CDS Pass.', '/dues');
  await log(e.gid, e.uid, 'dues_reminder', { label: d.data()!.title, notified: sent });
  return { ok: true, owing: owing.length, notified: sent };
});

/* ======================================================================================
 * PLATFORM ADMIN MODE (Derik + team)
 * --------------------------------------------------------------------------------------
 * Owner  = PLATFORM_ADMIN_STATE_CODE on Render. Can do everything, and manage the team.
 * Team   = platform/config.team { "LA/26B/1234": "admin" | "viewer" } (owner adds/removes).
 *          viewer: sees charts and all groups.  admin: also switches, broadcasts, creates groups.
 * Config = platform/config { signupsPaused, paymentsPaused, maintenance, banner, team }.
 *          Server-only document (clients can't read it); the app gets public bits via appStatus.
 * ====================================================================================== */

type PlatformRole = 'owner' | 'admin' | 'viewer';
interface PlatformConfig {
  signupsPaused?: boolean;
  paymentsPaused?: boolean;
  maintenance?: string | null;
  banner?: string | null;
  team?: Record<string, 'admin' | 'viewer'>;
}

const platformRef = () => db.doc('platform/config');
let configCache: { at: number; value: PlatformConfig } | null = null;

async function platformConfig(fresh = false): Promise<PlatformConfig> {
  if (!fresh && configCache && Date.now() - configCache.at < 30_000) return configCache.value;
  const value = ((await platformRef().get()).data() ?? {}) as PlatformConfig;
  configCache = { at: Date.now(), value };
  return value;
}

/** Works out the platform role from the login email (state code). */
async function roleForEmail(email: string | undefined | null): Promise<{ role: PlatformRole; stateCode: string } | null> {
  if (!email) return null;
  const e = email.toLowerCase();
  const owner = normalizeStateCode(process.env.PLATFORM_ADMIN_STATE_CODE);
  if (owner && stateCodeToEmail(owner).toLowerCase() === e) return { role: 'owner', stateCode: owner };
  const team = (await platformConfig()).team ?? {};
  for (const [sc, role] of Object.entries(team)) {
    if (stateCodeToEmail(sc).toLowerCase() === e) return { role, stateCode: sc };
  }
  return null;
}

async function platformMember(req: CallableRequest, need: PlatformRole = 'viewer') {
  const { uid } = signedIn(req);
  const email = (req.auth?.token?.email as string | undefined) ?? (await auth.getUser(uid)).email;
  const r = await roleForEmail(email);
  const rank = { viewer: 1, admin: 2, owner: 3 };
  if (!r || rank[r.role] < rank[need]) {
    throw fail('permission-denied', need === 'owner' ? 'Only the CDS Pass owner can do this.' : 'This is for the CDS Pass admin team only.');
  }
  const me = (await userRef(uid).get()).data();
  return { uid, ...r, name: (me?.fullName as string) ?? r.stateCode };
}

/** Used by main.ts: while maintenance is on, only the admin team can use the app. */
export async function maintenanceGate(action: string, email: string | undefined): Promise<string | null> {
  if (action.startsWith('admin') || action === 'appStatus') return null;
  const msg = (await platformConfig()).maintenance;
  if (!msg) return null;
  return (await roleForEmail(email)) ? null : msg;
}

/** Group switched off by the platform admin. */
async function assertGroupActive(gid: string) {
  const g = (await groupRef(gid).get()).data();
  if (g?.paused) throw fail('failed-precondition', 'This CDS group is paused on CDS Pass. Please contact your main exco.');
}

/** Public: banner + maintenance message (no login needed). */
export const appStatus = onCall(async () => {
  const c = await platformConfig();
  return { banner: c.banner ?? null, maintenance: c.maintenance ?? null, signupsPaused: !!c.signupsPaused, paymentsPaused: !!c.paymentsPaused };
});

/** Tells the app whether this login is on the admin team (shows the mode switch). */
export const adminWhoAmI = onCall(async (req: CallableRequest) => {
  if (!req.auth) return { role: null };
  const email = (req.auth.token?.email as string | undefined) ?? null;
  const r = await roleForEmail(email);
  return { role: r?.role ?? null };
});

/* ---------- overview: totals, charts, every group ---------- */

let overviewCache: { at: number; value: unknown } | null = null;

export const adminOverview = onCall(async (req: CallableRequest) => {
  await platformMember(req, 'viewer');
  // Cached for 5 minutes so opening the admin page doesn't burn database reads.
  if (!req.data?.refresh && overviewCache && Date.now() - overviewCache.at < 5 * 60_000) return overviewCache.value;

  const DAYS = 30;
  const days: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) days.push(lagosDate(Date.now() - i * 86_400_000));
  const since = days[0];
  const idx = new Map(days.map((d, i) => [d, i]));
  const signups = new Array(DAYS).fill(0);
  const checkins = new Array(DAYS).fill(0);
  const paidKobo = new Array(DAYS).fill(0);
  const earnedKobo = new Array(DAYS).fill(0);

  const [groupsSnap, usersSnap] = await Promise.all([db.collection('groups').get(), db.collection('users').get()]);
  const users = usersSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }));
  for (const u of users) {
    const t = u.createdAt?.toMillis?.();
    if (t) {
      const i = idx.get(lagosDate(t));
      if (i !== undefined) signups[i]++;
    }
  }

  const groups: Array<Record<string, any> & { members: number; lastMeeting: string | null }> = [];
  let totalOnlineKobo = 0;
  let totalCashKobo = 0;
  let totalEarnedKobo = 0;
  for (const g of groupsSnap.docs) {
    const gd = g.data();
    const mine = users.filter((u) => u.groupId === g.id);
    const approved = mine.filter((u) => u.status === 'approved');

    // Payments (all time, paid)
    const pays = await db.collection(`groups/${g.id}/payments`).where('status', '==', 'paid').get();
    let online = 0;
    let cash = 0;
    let earned = 0;
    for (const p of pays.docs) {
      const d = p.data();
      if (d.method === 'cash') cash += d.amountKobo ?? 0;
      else {
        online += d.amountKobo ?? 0;
        earned += d.feeKobo ?? 0;
      }
      const t = d.paidAt?.toMillis?.();
      if (t) {
        const i = idx.get(lagosDate(t));
        if (i !== undefined) {
          paidKobo[i] += d.amountKobo ?? 0;
          if (d.method !== 'cash') earnedKobo[i] += d.feeKobo ?? 0;
        }
      }
    }
    totalOnlineKobo += online;
    totalCashKobo += cash;
    totalEarnedKobo += earned;

    // Meetings in the last 30 days: count attendees cheaply (count() = 1 read per 1000 people)
    const sessions = await db.collection(`groups/${g.id}/sessions`).where(FieldPath.documentId(), '>=', since).get();
    let lastMeeting: string | null = null;
    let lastCheckins = 0;
    for (const s of sessions.docs) {
      const c = (await s.ref.collection('attendees').count().get()).data().count;
      const i = idx.get(s.id);
      if (i !== undefined) checkins[i] += c;
      if (!lastMeeting || s.id > lastMeeting) {
        lastMeeting = s.id;
        lastCheckins = c;
      }
    }

    groups.push({
      id: g.id,
      name: gd.name,
      lga: gd.lga,
      state: gd.state,
      joinCode: gd.joinCode,
      paused: !!gd.paused,
      mainExcoStateCode: gd.mainExcoStateCode ?? null,
      members: approved.length,
      pending: mine.filter((u) => u.status === 'pending').length,
      excos: approved.filter((u) => u.role === 'exco').length,
      noPhoto: approved.filter((u) => !u.photoURL).length,
      lastMeeting,
      lastCheckins,
      onlineKobo: online,
      cashKobo: cash,
      earnedKobo: earned,
      createdAt: gd.createdAt?.toMillis?.() ?? null,
    });
  }
  groups.sort((a, b) => b.members - a.members);

  const value = {
    generatedAt: Date.now(),
    totals: {
      groups: groups.length,
      activeGroups: groups.filter((g) => g.lastMeeting).length,
      members: users.filter((u) => u.status === 'approved').length,
      pending: users.filter((u) => u.status === 'pending').length,
      onlineKobo: totalOnlineKobo,
      cashKobo: totalCashKobo,
      earnedKobo: totalEarnedKobo,
      checkins30: checkins.reduce((a, b) => a + b, 0),
    },
    series: { days, signups, checkins, paidKobo, earnedKobo },
    groups,
  };
  overviewCache = { at: Date.now(), value };
  return value;
});

/* ---------- switches ---------- */

export const adminGetConfig = onCall(async (req: CallableRequest) => {
  const me = await platformMember(req, 'viewer');
  const c = await platformConfig(true);
  return {
    role: me.role,
    signupsPaused: !!c.signupsPaused,
    paymentsPaused: !!c.paymentsPaused,
    maintenance: c.maintenance ?? null,
    banner: c.banner ?? null,
    team: me.role === 'owner' ? Object.entries(c.team ?? {}).map(([stateCode, role]) => ({ stateCode, role })) : [],
    owner: normalizeStateCode(process.env.PLATFORM_ADMIN_STATE_CODE),
  };
});

export const adminSetConfig = onCall(async (req: CallableRequest) => {
  const me = await platformMember(req, 'admin');
  const d = req.data ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof d.signupsPaused === 'boolean') patch.signupsPaused = d.signupsPaused;
  if (typeof d.paymentsPaused === 'boolean') patch.paymentsPaused = d.paymentsPaused;
  for (const k of ['maintenance', 'banner'] as const) {
    if (k in d) patch[k] = typeof d[k] === 'string' && d[k].trim() ? text(d[k], k === 'banner' ? 'Banner' : 'Maintenance message', 3, 200) : null;
  }
  if (!Object.keys(patch).length) throw fail('invalid-argument', 'Nothing to change.');
  await platformRef().set({ ...patch, updatedBy: me.stateCode, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  configCache = null;
  console.log(`[platform] ${me.stateCode} changed`, patch);
  return { ok: true };
});

export const adminSetGroupPaused = onCall(async (req: CallableRequest) => {
  const me = await platformMember(req, 'admin');
  const gid = String(req.data?.gid ?? '');
  const paused = req.data?.paused === true;
  const g = await groupRef(gid).get();
  if (!g.exists) throw fail('not-found', 'Group not found.');
  await groupRef(gid).update({ paused });
  overviewCache = null;
  await log(gid, me.uid, paused ? 'group_paused' : 'group_resumed', { label: me.stateCode });
  return { ok: true };
});

/* ---------- broadcast ---------- */

export const adminBroadcast = onCall(async (req: CallableRequest) => {
  const me = await platformMember(req, 'admin');
  const title = text(req.data?.title, 'Title', 3, 60);
  const body = text(req.data?.body, 'Message', 3, 300);
  const audience = req.data?.audience === 'excos' ? 'excos' : 'everyone';
  const gids: string[] = Array.isArray(req.data?.gids) ? req.data.gids.map(String).slice(0, 200) : [];
  const link = MESSAGE_LINKS.has(req.data?.link) ? (req.data.link as string) : '/home';

  const users = await db.collection('users').where('status', '==', 'approved').get();
  const uids = users.docs
    .filter((u) => !gids.length || gids.includes(u.data().groupId))
    .filter((u) => audience === 'everyone' || u.data().role === 'exco')
    .map((u) => u.id);
  if (!uids.length) throw fail('failed-precondition', 'Nobody matches that choice.');
  const sent = await notify(uids, title, body, link, 'broadcast');
  await db.collection('platform/config/broadcasts').add({
    title,
    body,
    audience,
    gids,
    recipients: uids.length,
    delivered: sent,
    sentBy: me.stateCode,
    sentAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, recipients: uids.length, delivered: sent };
});

/* ---------- team (owner only) ---------- */

export const adminSetTeamMember = onCall(async (req: CallableRequest) => {
  const me = await platformMember(req, 'owner');
  const sc = normalizeStateCode(req.data?.stateCode);
  if (!sc) throw fail('invalid-argument', 'Enter a valid state code, e.g. LA/26B/1234.');
  if (sc === normalizeStateCode(process.env.PLATFORM_ADMIN_STATE_CODE)) throw fail('invalid-argument', 'That is the owner account.');
  const role = req.data?.role;
  if (role !== 'admin' && role !== 'viewer' && role !== null) throw fail('invalid-argument', 'Choose Admin or Viewer.');
  await platformRef().set({ team: { [sc]: role === null ? FieldValue.delete() : role } }, { merge: true });
  configCache = null;
  console.log(`[platform] ${me.stateCode} set team ${sc} = ${role}`);
  return { ok: true };
});
```

---

### `server/src/main.ts`

```ts
/**
 * CDS Pass API server (Express). Runs on Render; locally with `npm run dev`.
 *
 *   POST /api/<action>      { data }  →  { result }   (same actions the app already uses)
 *   POST /paystack/webhook             Paystack payment events
 *   GET  /health                       for Render and keep-awake pings
 */
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError, type Callable, type RawEndpoint } from './compat';
import * as handlers from './handlers';
import { uploadRouter } from './upload';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const configuredOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const origins = [...new Set([...configuredOrigins, 'https://cdspass.name.ng'])];
app.use(cors({ origin: origins, maxAge: 86400 }));

// Profile photos → Cloudinary (multipart upload, so this goes before express.json)
app.use('/upload', uploadRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Paystack needs the exact raw body to check its signature.
app.post('/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const raw = req.body as Buffer;
  const r = req as Request & { rawBody?: Buffer };
  r.rawBody = raw;
  try {
    r.body = JSON.parse(raw.toString('utf8'));
  } catch {
    r.body = {};
  }
  try {
    await (handlers.paystackWebhook as RawEndpoint).handler(r, res);
  } catch (err) {
    console.error('webhook error', err);
    if (!res.headersSent) res.status(500).send('error');
  }
});

app.use(express.json({ limit: '200kb' }));

const STATUS: Record<string, number> = {
  'invalid-argument': 400,
  'failed-precondition': 400,
  'out-of-range': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  aborted: 409,
  'resource-exhausted': 429,
  unimplemented: 501,
  unavailable: 503,
  'deadline-exceeded': 504,
};

/**
 * Automatic dues reminders. cron-job.org calls this twice a day (e.g. 07:00 and 18:00 Lagos):
 *   GET /cron/reminders?key=<CRON_SECRET>
 */
app.get('/cron/reminders', async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.query.key !== secret) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  try {
    res.json(await handlers.runDuesReminders());
  } catch (e) {
    console.error('[cron/reminders]', e);
    res.status(500).json({ error: 'failed' });
  }
});

const actions = handlers as unknown as Record<string, Callable | RawEndpoint | undefined>;

app.post('/api/:name', async (req: Request, res: Response) => {
  const fn = actions[req.params.name];
  if (!fn || !('__callable' in fn)) {
    res.status(404).json({ error: { status: 'not-found', message: 'Unknown action.' } });
    return;
  }

  let auth: { uid: string; token: Record<string, unknown> } | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const decoded = await getAuth().verifyIdToken(header.slice(7));
      auth = { uid: decoded.uid, token: decoded as unknown as Record<string, unknown> };
    } catch {
      res.status(401).json({ error: { status: 'unauthenticated', message: 'Your login has expired. Please log in again.' } });
      return;
    }
  }

  // Maintenance mode (switched on in Admin mode): only the admin team can use the app meanwhile.
  try {
    const blocked = await handlers.maintenanceGate(req.params.name, auth?.token?.email as string | undefined);
    if (blocked) {
      res.status(503).json({ error: { status: 'unavailable', message: blocked } });
      return;
    }
  } catch (e) {
    console.error('[maintenance check]', e);
  }

  try {
    const result = await fn.handler({ data: req.body?.data ?? {}, auth, rawRequest: req });
    res.json({ result: result ?? null });
  } catch (e) {
    if (e instanceof HttpsError) {
      res.status(STATUS[e.code] ?? 400).json({ error: { status: e.code, message: e.message } });
      return;
    }
    console.error(`[${req.params.name}]`, e);
    res.status(500).json({ error: { status: 'internal', message: 'Something went wrong on the server. Please try again.' } });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`CDS Pass API listening on :${port}`);
  console.log(`Allowed websites: ${origins.join(', ')}`);
});
```

---

### `server/src/mongo.ts`

```ts
import { MongoClient, type Collection, type Document } from 'mongodb';

let clientPromise: Promise<MongoClient> | null = null;

export function mongoConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

export async function mongoCollection<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured.');
  if (!clientPromise) {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
    clientPromise = client.connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DATABASE || 'cds_pass').collection<T>(name);
}
```

---

### `server/src/shared.ts`

```ts
// Logic shared in spirit with web/src/lib/rules.ts — keep the two in sync.

export const STATE_CODE_RE = /^[A-Z]{2}\/\d{2}[A-C]\/\d{4,5}$/;

/** "la/26b/1142", "LA 26B 1142", "LA-26B-1142" -> "LA/26B/1142" (or null if invalid). */
export function normalizeStateCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.toUpperCase().trim().replace(/[-\\]/g, '/').replace(/\s*\/\s*/g, '/');
  if (!s.includes('/')) {
    const m = s.replace(/\s+/g, '').match(/^([A-Z]{2})(\d{2}[A-C])(\d{4,5})$/);
    if (m) s = `${m[1]}/${m[2]}/${m[3]}`;
  }
  s = s.replace(/\s+/g, '');
  return STATE_CODE_RE.test(s) ? s : null;
}

/** Firebase Auth needs an email; members never see this. */
export function stateCodeToEmail(stateCode: string): string {
  return `${stateCode.replace(/\//g, '').toLowerCase()}@cdspass.app`;
}

/** Nigerian phone numbers: 0803..., +234803..., 234803... -> +234803... */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const d = input.replace(/[\s()-]/g, '');
  const m = d.match(/^(?:\+?234|0)([789]\d{9})$/);
  return m ? `+234${m[1]}` : null;
}

/** Calendar day in Lagos, e.g. "2026-10-29". One CDS session per group per day. */
export function lagosDate(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export type Batch =
  | { kind: 'priority'; seq: number; calledAt?: unknown }
  | { kind: 'regular'; seq: number; from: number; to: number; calledAt?: unknown };

export interface AttendeeLike {
  number: number;
  priority?: boolean;
  status: 'waiting' | 'done';
}

/**
 * Is it this person's turn at the thumbprint table?
 * - Priority (pregnant / nursing mothers): any time once thumbprinting has started.
 * - Everyone else: once their batch (or a later one) has been called.
 *   No. 41 is refused while 21–40 is being called.
 */
export function isTurn(att: AttendeeLike, batch: Batch | null | undefined): boolean {
  if (!batch || att.status !== 'waiting') return false;
  if (att.priority) return true;
  return batch.kind === 'regular' && att.number <= batch.to;
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Online dues charges. The member pays dues + 4.5%:
 *   3%   service fee (yours)
 *   1.5% to cover Paystack's own charge
 * The CDS group always gets the full dues. Each part is rounded up to the next naira.
 * Change with SERVICE_FEE_PERCENT / PAYSTACK_FEE_PERCENT (server) and the VITE_ ones (web).
 */
export function duesCharges(amountKobo: number, servicePercent = 3, paystackPercent = 1.5) {
  const up = (k: number) => Math.ceil(k / 100) * 100;
  const serviceKobo = up((amountKobo * servicePercent) / 100);
  // Paystack charges 1.5% of the TOTAL, plus ₦100 when the total is ₦2,500 or more, capped at ₦2,000.
  // Work out the part that exactly covers that, so the group gets the full dues and you keep the full 3%.
  const base = amountKobo + serviceKobo;
  const rate = paystackPercent / 100;
  let paystackKobo = up((base * rate) / (1 - rate));
  if (base + paystackKobo >= 250_000) paystackKobo = up((base * rate + 10_000) / (1 - rate));
  paystackKobo = Math.min(paystackKobo, 200_000);
  return { serviceKobo, paystackKobo, chargesKobo: serviceKobo + paystackKobo, totalKobo: base + paystackKobo };
}
```

---

### `server/src/upload.ts`

```ts
/**
 * Profile-photo upload (Cloudinary).
 *
 *   POST /upload/avatar    multipart/form-data, field "file"   →  { url }
 *
 * Same idea as BlockHub: the phone sends the photo to OUR server, the server
 * puts it on Cloudinary, and sends back the URL. The app then saves only that
 * URL in Firestore (users/{uid}.photoURL).
 *
 * Only a logged-in person can upload, and each person can only ever write
 * their OWN photo (the Cloudinary file name is their uid), so uploading a new
 * photo replaces the old one instead of piling up files.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const MAX_BYTES = 2 * 1024 * 1024; // photos are compressed to ~50 KB in the browser; 2 MB is plenty

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ error: { message } });

/** Same login check as the /api actions: Firebase ID token in the Authorization header. */
async function requireLogin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return fail(res, 401, 'Please log in again.');
  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7));
    (req as Request & { uid?: string }).uid = decoded.uid;
    next();
  } catch {
    fail(res, 401, 'Your login has expired. Please log in again.');
  }
}

export const uploadRouter = Router();

uploadRouter.post(
  '/avatar',
  requireLogin,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next();
      const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      fail(res, 400, tooBig ? 'That photo is too big. Choose a smaller one.' : 'Could not read the photo.');
    });
  },
  (req: Request, res: Response) => {
    const uid = (req as Request & { uid?: string }).uid!;
    const file = req.file;

    if (!file) return fail(res, 400, 'No photo was sent.');
    if (!file.mimetype.startsWith('image/')) return fail(res, 400, 'Please choose a photo.');
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error('Cloudinary is not configured (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET missing).');
      return fail(res, 500, 'Photo upload is not set up on the server yet.');
    }

    const started = Date.now();
    let answered = false;
    // Never leave the phone waiting: if Cloudinary hasn't answered in 30 s, say so.
    const guard = setTimeout(() => {
      if (answered) return;
      answered = true;
      console.error(`Cloudinary upload timed out after 30s (uid ${uid}, ${file.size} bytes)`);
      fail(res, 504, 'Photo upload is slow right now. Please try again.');
    }, 30_000);

    const stream = cloudinary.uploader.upload_stream(
      {
        timeout: 30_000,
        resource_type: 'image',
        folder: 'cds-pass/avatars',
        public_id: uid, // one photo per person: a new upload replaces the old one
        overwrite: true,
        transformation: [{ width: 512, height: 512, crop: 'limit', quality: 'auto' }],
      },
      (error, result) => {
        clearTimeout(guard);
        if (answered) return;
        answered = true;
        console.log(`avatar upload ${error ? 'FAILED' : 'ok'} in ${Date.now() - started}ms (${file.size} bytes)`);
        if (error || !result) {
          console.error('Cloudinary upload failed:', error);
          return fail(res, 500, 'Could not upload your photo. Please try again.');
        }
        // secure_url contains a version number (…/v1731234567/…), so a replaced photo gets a new URL.
        res.json({ url: result.secure_url });
      },
    );
    stream.end(file.buffer);
  },
);
```

---

### `server/tsconfig.json`

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "es2022",
    "lib": ["es2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

---

### `web/.env.example`

```bash
# Copy this file to .env and fill in the values from
# Firebase console → Project settings → Your apps → Web app → SDK setup and configuration.
VITE_FB_API_KEY=
VITE_FB_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FB_PROJECT_ID=your-project
VITE_FB_STORAGE_BUCKET=your-project.appspot.com
VITE_FB_MESSAGING_SENDER_ID=
VITE_FB_APP_ID=

# Firebase console → Project settings → Cloud Messaging → Web Push certificates → Key pair
VITE_FB_VAPID_KEY=

# The API server: http://localhost:8787 on your PC, https://<name>.onrender.com when live
VITE_API_URL=http://localhost:8787

# true = talk to the local Firebase emulators instead of the real project
VITE_USE_EMULATORS=false

# Online dues charges shown to members. Must match SERVICE_FEE_PERCENT / PAYSTACK_FEE_PERCENT on the server.
VITE_SERVICE_FEE_PERCENT=3
VITE_PAYSTACK_FEE_PERCENT=1.5
```

---

### `web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0B6B3A" />
    <meta name="description" content="CDS Pass: no more queueing for numbers at CDS. Independent tool for CDS groups." />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="CDS Pass" />
    <meta property="og:title" content="CDS Pass — No more queueing for numbers at CDS" />
    <meta property="og:description" content="Scan in, get your number, and know when it's your turn to thumbprint." />
    <meta property="og:url" content="https://cdspass.name.ng/" />
    <meta property="og:image" content="https://cdspass.name.ng/share-card-3d.png" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="CDS Pass helps CDS members check in, get a number, and know when it is their turn." />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="CDS Pass — No more queueing for numbers at CDS" />
    <meta name="twitter:description" content="Scan in, get your number, and know when it's your turn to thumbprint." />
    <meta name="twitter:image" content="https://cdspass.name.ng/share-card-3d.png" />
    <meta name="twitter:image:alt" content="CDS Pass helps CDS members check in, get a number, and know when it is their turn." />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="shortcut icon" href="/icon-192.png" type="image/png" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="canonical" href="https://cdspass.name.ng/" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Poppins:wght@600;700;800&display=swap"
      rel="stylesheet"
    />
    <title>CDS Pass</title>
    <script>
      // Apply dark/light mode before the page paints (no white flash at night).
      try {
        var m = localStorage.getItem('cdspass:theme');
        if (m === 'dark' || (m !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches))
          document.documentElement.classList.add('dark');
      } catch (e) {}
    </script>
  </head>
  <body>
    <div id="root">
      <!-- Shown until the app's code has downloaded (React replaces it). Slow networks no longer see a blank page. -->
      <div id="boot" style="min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:system-ui,sans-serif;background:#0B6B3A;color:#fff;text-align:center;padding:24px">
        <div style="width:72px;height:72px;border-radius:22px;background:#fff;color:#0B6B3A;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px">CDS</div>
        <div style="font-size:20px;font-weight:800">CDS Pass</div>
        <div id="boot-msg" style="font-size:14px;opacity:.85">Loading…</div>
        <button id="boot-retry" onclick="location.reload()" style="display:none;height:44px;padding:0 22px;border:0;border-radius:14px;background:#fff;color:#0B6B3A;font-weight:800;font-size:15px">Try again</button>
      </div>
    </div>
    <script>
      // If the code is slow or fails to download, say so instead of staying blank.
      (function () {
        function show(msg, retry) {
          var m = document.getElementById('boot-msg'), b = document.getElementById('boot-retry');
          if (!m) return; // app already started
          m.textContent = msg;
          if (retry && b) b.style.display = 'inline-block';
        }
        setTimeout(function () { show('Still loading… your network seems slow. Please wait a little.'); }, 8000);
        setTimeout(function () { show('This is taking too long. Check your data or network, then try again.', true); }, 30000);
        window.addEventListener('error', function (e) {
          var t = e && e.target;
          if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) show('Could not load the app. Check your network and try again.', true);
        }, true);
      })();
    </script>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

### `web/package.json`

```json
{
  "name": "cds-pass-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@react-three/drei": "^9.114.0",
    "@react-three/fiber": "^8.17.10",
    "firebase": "^10.14.0",
    "framer-motion": "^11.11.0",
    "qr-scanner": "^1.4.2",
    "qrcode.react": "^4.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2",
    "three": "^0.169.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.0",
    "@types/three": "^0.169.0",
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.2",
    "vite": "^5.4.8"
  }
}
```

---

### `web/postcss.config.js`

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

---

### `web/public/.htaccess`

```
# Send React Router paths (for example /exco) back to the single-page app.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>

# Compress text files (JS, CSS, HTML) so phones download about a third of the size.
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml
</IfModule>

# Files in /assets have a unique name per build, so phones can keep them for a year.
# index.html must always be checked again, so a new upload shows up straight away.
<IfModule mod_headers.c>
  <FilesMatch "\.(js|css)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "^(index\.html|firebase-messaging-sw\.js|manifest\.webmanifest)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
</IfModule>

<IfModule mod_mime.c>
  AddType application/manifest+json .webmanifest
</IfModule>
```

---

### `web/public/firebase-messaging-sw.js`

```js
/* CDS Pass service worker: push notifications (FCM) + simple offline cache.
 * Firebase config arrives in the query string when the page registers this file,
 * so no keys are hard-coded here. */
importScripts('https://www.gstatic.com/firebasejs/10.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.0/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
const config = {
  apiKey: params.get('apiKey'),
  projectId: params.get('projectId'),
  messagingSenderId: params.get('messagingSenderId'),
  appId: params.get('appId'),
};

if (config.apiKey && config.messagingSenderId) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  // The server sends data-only messages; we show the notification ourselves.
  messaging.onBackgroundMessage((payload) => {
    const d = payload.data || {};
    self.registration.showNotification(d.title || 'CDS Pass', {
      body: d.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'cds-batch',
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 120, 300, 120, 300],
      data: { link: d.link || '/tag' },
    });
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/tag';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(link);
          return c.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});

// ---- offline cache: network first, fall back to the last copy we saw ----
const CACHE = 'cdspass-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req.mode === 'navigate' ? '/' : req)
          .then((r) => r || Response.error()),
      ),
  );
});
```

---

### `web/public/icon.svg`

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#0B6B3A"/>
  <rect x="136" y="96" width="240" height="320" rx="36" fill="#F3F7F2"/>
  <rect x="136" y="96" width="240" height="72" rx="36" fill="#C9B783"/>
  <rect x="136" y="132" width="240" height="36" fill="#C9B783"/>
  <path d="M206 290 l36 36 l70 -84" fill="none" stroke="#0B6B3A" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

---

### `web/public/manifest.webmanifest`

```json
{
  "name": "CDS Pass",
  "short_name": "CDS Pass",
  "description": "Check in, get your number, and know when it's your turn to thumbprint.",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "orientation": "portrait",
  "display": "standalone",
  "background_color": "#F3F7F2",
  "theme_color": "#0B6B3A",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

---

### `web/scripts/generate-share-card.ps1`

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$width = 1200
$height = 630
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Draw-RoundedRect($graphics, [System.Drawing.RectangleF]$rect, [single]$radius, $brush, $pen = $null) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  if ($brush) { $graphics.FillPath($brush, $path) }
  if ($pen) { $graphics.DrawPath($pen, $path) }
  $path.Dispose()
}

$background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(0, 0, $width, $height),
  [System.Drawing.Color]::FromArgb(5, 37, 23),
  [System.Drawing.Color]::FromArgb(8, 91, 49), 35
)
$graphics.FillRectangle($background, 0, 0, $width, $height)
$background.Dispose()

# Fine grid and glow pools echo the animated landing hero.
$gridPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(17, 205, 246, 215), 1)
for ($x = 0; $x -lt $width; $x += 42) { $graphics.DrawLine($gridPen, $x, 0, $x, $height) }
for ($y = 0; $y -lt $height; $y += 42) { $graphics.DrawLine($gridPen, 0, $y, $width, $y) }
$gridPen.Dispose()
foreach ($glow in @(@(920, 270, 330, 330, 46, 32, 170, 80), @(210, 540, 390, 220, 30, 14, 109, 64))) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddEllipse([single]$glow[0], [single]$glow[1], [single]$glow[2], [single]$glow[3])
  $brush = [System.Drawing.Drawing2D.PathGradientBrush]::new($path)
  $brush.CenterColor = [System.Drawing.Color]::FromArgb([int]$glow[4], [int]$glow[5], [int]$glow[6], [int]$glow[7])
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $graphics.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

$lime = [System.Drawing.Color]::FromArgb(14, 220, 92)
$gold = [System.Drawing.Color]::FromArgb(201, 183, 131)
$white = [System.Drawing.Color]::White
$mint = [System.Drawing.Color]::FromArgb(198, 232, 211)

# Brand lockup.
$iconBrush = [System.Drawing.SolidBrush]::new($lime)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(84, 58, 44, 44)) 12 $iconBrush
$iconBrush.Dispose()
$checkPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(5, 52, 29), 4)
$checkPen.StartCap = 'Round'
$checkPen.EndCap = 'Round'
$checkPoints = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(96, 80),
  [System.Drawing.Point]::new(103, 87),
  [System.Drawing.Point]::new(117, 69)
)
$graphics.DrawLines($checkPen, $checkPoints)
$checkPen.Dispose()
$fontBrand = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brandBrush = [System.Drawing.SolidBrush]::new($white)
$graphics.DrawString('CDS PASS', $fontBrand, $brandBrush, 142, 62)
[System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(170, 201, 183, 131), 3) | ForEach-Object { $graphics.DrawLine($_, 84, 119, 166, 119); $_.Dispose() }

# Headline and supporting copy.
$headline = [System.Drawing.Font]::new('Segoe UI', 54, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$headlineAccent = [System.Drawing.Font]::new('Segoe UI', 61, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = [System.Drawing.Font]::new('Segoe UI', 23, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$smallBold = [System.Drawing.Font]::new('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$whiteBrush = [System.Drawing.SolidBrush]::new($white)
$limeBrush = [System.Drawing.SolidBrush]::new($lime)
$mintBrush = [System.Drawing.SolidBrush]::new($mint)
$goldBrush = [System.Drawing.SolidBrush]::new($gold)
$graphics.DrawString('No more queueing', $headline, $whiteBrush, 82, 170)
$graphics.DrawString('for CDS numbers.', $headlineAccent, $limeBrush, 82, 235)
$graphics.DrawString('Check in. Get your number.', $bodyFont, $mintBrush, 86, 336)
$graphics.DrawString("Know when it's your turn to thumbprint.", $bodyFont, $mintBrush, 86, 372)
$chipBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, 255, 255, 255))
$chipPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(60, 255, 255, 255), 1)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(84, 445, 318, 44)) 18 $chipBrush $chipPen
$graphics.DrawString('A simpler, fairer CDS check-in', $smallBold, $goldBrush, 103, 457)

# Floating 3D tag: thick edge, tilted face, layered card, and lanyard clip.
$state = $graphics.Save()
$graphics.TranslateTransform(935, 309)
$graphics.RotateTransform(-5)
$graphics.TranslateTransform(-935, -309)
$shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(95, 0, 0, 0))
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(756, 111, 366, 468)) 34 $shadowBrush
$shadowBrush.Dispose()
$edgeBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(1059, 93, 42, 484),
  [System.Drawing.Color]::FromArgb(4, 55, 29), [System.Drawing.Color]::FromArgb(2, 25, 14), 0
)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(760, 103, 366, 466)) 34 $edgeBrush
$edgeBrush.Dispose()
$cardBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(736, 83, 365, 466),
  [System.Drawing.Color]::FromArgb(16, 139, 76), [System.Drawing.Color]::FromArgb(3, 66, 36), 42
)
$cardPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(100, 215, 255, 228), 2)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(738, 84, 365, 466)) 34 $cardBrush $cardPen
$cardBrush.Dispose()
$cardPen.Dispose()
$panelBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(770, 139, 302, 373),
  [System.Drawing.Color]::FromArgb(250, 253, 248), [System.Drawing.Color]::FromArgb(222, 240, 228), 55
)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(770, 139, 302, 373)) 23 $panelBrush
$panelBrush.Dispose()
$tagFont = [System.Drawing.Font]::new('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$tinyFont = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$numberFont = [System.Drawing.Font]::new('Segoe UI', 116, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$turnFont = [System.Drawing.Font]::new('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$darkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(5, 48, 27))
$greenBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(9, 112, 58))
$mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(75, 103, 84))
$graphics.DrawString('CDS PASS', $tagFont, $darkBrush, 797, 158)
$badgeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(218, 238, 224))
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(965, 154, 87, 30)) 14 $badgeBrush
$graphics.DrawString('CDS TAG', $tinyFont, $greenBrush, 979, 162)
$separatorPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(100, 11, 107, 58), 2)
$graphics.DrawLine($separatorPen, 798, 204, 1045, 204)
$separatorPen.Dispose()
$graphics.DrawString('YOUR NUMBER', $tinyFont, $mutedBrush, 839, 236)
# Raised number shadow, then face.
$numberShadow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(70, 3, 55, 29))
$graphics.DrawString('14', $numberFont, $numberShadow, 831, 268)
$graphics.DrawString('14', $numberFont, $greenBrush, 824, 253)
$numberShadow.Dispose()
$turnBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(9, 112, 58))
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(797, 421, 249, 57)) 17 $turnBrush
$graphics.DrawString("YOU'RE UP NEXT", $turnFont, $whiteBrush, 842, 439)
$graphics.DrawString('SCAN IN  |  GET CALLED  |  THUMBPRINT', $tinyFont, $mintBrush, 790, 522)
$clipPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(238, 201, 183, 131), 9)
$graphics.DrawArc($clipPen, 879, 48, 78, 96, 190, 160)
$graphics.DrawLine($clipPen, 897, 104, 897, 128)
$graphics.DrawLine($clipPen, 939, 104, 939, 128)
$clipPen.Dispose()
$graphics.Restore($state)

# Floating polished orbs mirror the landing hero.
foreach ($orb in @(@(1112, 160, 32, 32, 14, 220, 92), @(694, 494, 26, 26, 201, 183, 131), @(1115, 445, 20, 20, 213, 241, 223))) {
  $rect = [System.Drawing.Rectangle]::new([int]$orb[0], [int]$orb[1], [int]$orb[2], [int]$orb[3])
  $orbBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.Color]::FromArgb(245, [int]$orb[4], [int]$orb[5], [int]$orb[6]),
    [System.Drawing.Color]::FromArgb(100, 5, 48, 27), 45
  )
  $graphics.FillEllipse($orbBrush, $rect)
  $orbBrush.Dispose()
  $highlight = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(110, 255, 255, 255))
  $graphics.FillEllipse($highlight, $rect.X + 5, $rect.Y + 4, 7, 7)
  $highlight.Dispose()
}

# The simple journey remains readable in WhatsApp's small preview.
$graphics.DrawString('SCAN IN', $smallBold, $mintBrush, 86, 548)
$graphics.DrawString('>', $smallBold, $goldBrush, 169, 546)
$graphics.DrawString('GET YOUR NUMBER', $smallBold, $mintBrush, 198, 548)
$graphics.DrawString('>', $smallBold, $goldBrush, 374, 546)
$graphics.DrawString('THUMBPRINT ON TIME', $smallBold, $mintBrush, 402, 548)

$output = Join-Path (Get-Location) 'web/public/share-card-3d.png'
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "Wrote $output at 1200x630."
```

---

### `web/src/App.tsx`

```tsx
import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { InstallGate } from './components/InstallGate';
import { SideNav } from './components/SideNav';
import { Toaster } from './components/Toaster';
import { Spinner } from './components/ui';
import { useAuth } from './hooks/useAuth';
import { startOfflineSync } from './lib/offlineQueue';
import { useSignupLock } from './lib/signupLock';
import Login from './pages/Login';
import Pending from './pages/Pending';
import Signup from './pages/Signup';
import Welcome from './pages/Welcome';
import Home from './pages/member/Home';
import MyTag from './pages/member/MyTag';
import Profile from './pages/member/Profile';
import ScanIn from './pages/member/ScanIn';
import Dues from './pages/member/Dues';
import DuesAdmin from './pages/exco/DuesAdmin';
import CallBatch from './pages/exco/CallBatch';
import Dashboard from './pages/exco/Dashboard';
import Door from './pages/exco/Door';
import { AnnouncementBanner, MaintenanceScreen, ModeSwitch } from './components/PlatformChrome';
// Admin mode is only for the CDS Pass team, so it loads separately (keeps the app small for everyone else).
const Admin = lazy(() => import('./pages/admin/Admin'));
import GiveNumber from './pages/exco/GiveNumber';
import Messages from './pages/exco/Messages';
import Members from './pages/exco/Members';
import PrintCards from './pages/exco/PrintCards';
import Settings from './pages/exco/Settings';
import Table from './pages/exco/Table';

function Splash() {
  return (
    <div className="hero-green grid min-h-[100dvh] place-items-center">
      <div className="flex flex-col items-center gap-4 text-white">
        <img src="/icon.svg" alt="" className="h-20 w-20 rounded-3xl shadow-lift" />
        <Spinner light />
      </div>
    </div>
  );
}

function ProfileReadError({ message, onLogout }: { message: string; onLogout: () => void }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-paper px-6 text-ink">
      <div className="w-full max-w-md space-y-4 rounded-3xl bg-card p-6 shadow-card">
        <h1 className="text-xl font-extrabold">Couldn’t load your CDS profile</h1>
        <p className="text-sm text-muted">
          Your login worked, but CDS Pass could not check your saved registration. This can happen if the connection
          failed or this website is connected to a different Firebase project. Your account has not been deleted.
        </p>
        <p className="break-words rounded-xl bg-line p-3 text-xs text-muted">{message}</p>
        <button onClick={() => window.location.reload()} className="h-12 w-full rounded-2xl bg-green font-bold text-white">
          Try again
        </button>
        <button onClick={onLogout} className="w-full py-2 text-sm font-bold text-muted">
          Log out
        </button>
      </div>
    </div>
  );
}

/** Approved, but this phone's login doesn't carry the new permissions yet. Never wait forever. */
function WaitingForAccess() {
  const { refreshClaims, logout } = useAuth();
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return <Splash />;
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-paper px-6 text-ink">
      <div className="w-full max-w-md space-y-4 rounded-3xl bg-card p-6 text-center shadow-card">
        <h1 className="text-xl font-extrabold">Setting up your access…</h1>
        <p className="text-sm text-muted">This is taking longer than usual. Check your internet, then try again.</p>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void refreshClaims().finally(() => setBusy(false));
          }}
          className="h-12 w-full rounded-2xl bg-green font-bold text-white disabled:opacity-60"
        >
          {busy ? 'Checking…' : 'Try again'}
        </button>
        <button onClick={() => void logout()} className="w-full py-2 text-sm font-bold text-muted">
          Log out and log in again
        </button>
      </div>
    </div>
  );
}

/** Phone: one column + bottom bar. Laptop: sidebar + wider content. */
function AppShell({ mode }: { mode: 'member' | 'exco' }) {
  return (
    <div className="min-h-[100dvh] bg-paper lg:flex">
      <SideNav mode={mode} />
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col lg:max-w-4xl lg:px-10 lg:pt-4">
        <Outlet />
      </div>
      <BottomNav mode={mode} />
    </div>
  );
}

function MemberLayout() {
  return <AppShell mode="member" />;
}

function ExcoLayout() {
  const { profile } = useAuth();
  if (profile?.role !== 'exco') return <Navigate to="/home" replace />;
  return <AppShell mode="exco" />;
}

export default function App() {
  const { user, profile, profileError, ready, logout } = useAuth();
  const lock = useSignupLock();

  useEffect(() => {
    if (ready) startOfflineSync();
  }, [ready]);

  if (user && profileError) {
    return (
      <InstallGate>
        <ProfileReadError message={profileError} onLogout={() => void logout()} />
      </InstallGate>
    );
  }

  let routes: JSX.Element;
  if (user === undefined || (!lock && user && profile === undefined)) {
    return (
      <InstallGate>
        <Splash />
      </InstallGate>
    );
  } else if (!user || lock === 'signup') {
    routes = (
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  } else if (profile === null || lock === 'finish') {
    // Account created but registration not finished (e.g. data cut off mid-signup).
    routes = (
      <Routes>
        <Route path="/signup" element={<Signup finish />} />
        <Route path="*" element={<Navigate to="/signup" replace />} />
      </Routes>
    );
  } else if (profile && profile.status !== 'approved') {
    routes = (
      <Routes>
        <Route path="/pending" element={<Pending />} />
        <Route path="*" element={<Navigate to="/pending" replace />} />
      </Routes>
    );
  } else if (!ready) {
    return (
      <InstallGate>
        <WaitingForAccess />
      </InstallGate>
    );
  } else {
    const homePath = profile?.role === 'exco' ? '/exco' : '/home';
    routes = (
      <Routes>
        <Route element={<MemberLayout />}>
          <Route path="/home" element={<Home />} />
          <Route path="/scan" element={<ScanIn />} />
          <Route path="/tag" element={<MyTag />} />
          <Route path="/dues" element={<Dues />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
        <Route path="/exco" element={<ExcoLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="door" element={<Door />} />
          <Route path="call" element={<CallBatch />} />
          <Route path="table" element={<Table />} />
          <Route path="members" element={<Members />} />
          <Route path="dues" element={<DuesAdmin />} />
          <Route path="settings" element={<Settings />} />
          <Route path="give-number" element={<GiveNumber />} />
          <Route path="messages" element={<Messages />} />
        </Route>
        <Route path="/exco/cards" element={profile?.role === 'exco' ? <PrintCards /> : <Navigate to="/home" replace />} />
        <Route
          path="/admin"
          element={
            <Suspense fallback={<Splash />}>
              <Admin />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to={homePath} replace />} />
      </Routes>
    );
  }

  return (
    <InstallGate>
      <Toaster />
      <AnnouncementBanner />
      <ModeSwitch />
      <MaintenanceScreen>{routes}</MaintenanceScreen>
    </InstallGate>
  );
}
```

---

### `web/src/components/Avatar.tsx`

```tsx
export function Avatar({ src, name, size = 48, ring = false }: { src?: string | null; name: string; size?: number; ring?: boolean }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-full bg-green-light ${ring ? 'ring-4 ring-white shadow-lift' : ''}`}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="grid h-full w-full place-items-center font-extrabold text-green" style={{ fontSize: size * 0.36 }}>
          {initials}
        </div>
      )}
    </div>
  );
}
```

---

### `web/src/components/BottomNav.tsx`

```tsx
import { motion } from 'framer-motion';
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from './ui';

export const memberTabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/home', label: 'Home', icon: 'home' },
  { to: '/scan', label: 'Scan in', icon: 'scan' },
  { to: '/tag', label: 'My tag', icon: 'tag' },
  { to: '/dues', label: 'Dues', icon: 'card' },
  { to: '/profile', label: 'Profile', icon: 'user' },
];

export const excoTabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/exco', label: 'Today', icon: 'grid' },
  { to: '/exco/door', label: 'Door', icon: 'door' },
  { to: '/exco/call', label: 'Call', icon: 'megaphone' },
  { to: '/exco/table', label: 'Table', icon: 'finger' },
  { to: '/exco/members', label: 'Members', icon: 'users' },
];

export function BottomNav({ mode }: { mode: 'member' | 'exco' }) {
  const tabs = mode === 'exco' ? excoTabs : memberTabs;
  return (
    <nav className="no-print fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md lg:hidden px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="flex justify-around rounded-3xl border border-line bg-card/95 p-1.5 shadow-lift backdrop-blur">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/exco'}
            className={({ isActive }) =>
              `relative flex min-h-[52px] min-w-[58px] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-bold ${
                isActive ? 'text-white' : 'text-muted'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId={`nav-${mode}`}
                    className="absolute inset-0 rounded-2xl bg-green"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">
                  <Icon name={t.icon} size={21} />
                </span>
                <span className="relative">{t.label}</span>
                {isActive && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-gold" />}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
```

---

### `web/src/components/ErrorBoundary.tsx`

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** If a screen crashes, show what happened instead of a blank white page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CDS Pass crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-paper p-6 text-ink">
        <div className="card w-full max-w-md space-y-4 text-center">
          <p className="text-2xl font-extrabold">Something went wrong</p>
          <p className="text-sm text-muted">Please try again. If it keeps happening, send this message to the developer:</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-2xl bg-bad-bg p-3 text-left text-xs text-bad">
            {error.message}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="h-14 w-full rounded-2xl bg-green font-bold text-white"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
```

---

### `web/src/components/ExcoHeader.tsx`

```tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './ui';

export function ExcoHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="hero-green px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-7 lg:pb-6 lg:pt-6">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold tracking-[0.2em] text-green-mid">EXCO</p>
          <h1 className="truncate text-2xl font-extrabold">{title}</h1>
          {sub && <p className="truncate text-xs font-semibold text-green-mid">{sub}</p>}
        </div>
        <div className="flex gap-2">
          <Link to="/home" aria-label="My own tag" className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
            <Icon name="tag" size={20} />
          </Link>
          <Link to="/exco/settings" aria-label="Settings" className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
            <Icon name="settings" size={20} />
          </Link>
        </div>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}
```

---

### `web/src/components/Hero3D.tsx`

```tsx
import { Float, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

/** Draws the front of the floating tag onto a texture (no font downloads needed). */
function useTagTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 740;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 512, 740);
    grad.addColorStop(0, '#0E7F46');
    grad.addColorStop(1, '#064726');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 740);

    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let x = 12; x < 512; x += 24) for (let y = 12; y < 740; y += 24) g.fillRect(x, y, 2, 2);

    g.fillStyle = '#FFFFFF';
    g.font = '800 34px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText('CDS PASS', 40, 70);

    g.fillStyle = '#E3F2E8';
    g.beginPath();
    g.arc(90, 165, 46, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(156, 140, 220, 22);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(156, 176, 150, 16);

    g.fillStyle = '#CFE6D6';
    g.font = '700 22px "Plus Jakarta Sans", system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('YOUR NUMBER', 256, 300);
    g.fillStyle = '#FFFFFF';
    g.font = '800 230px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText('14', 256, 500);

    g.fillStyle = '#FFFFFF';
    g.beginPath();
    if (typeof g.roundRect === 'function') g.roundRect(40, 590, 432, 90, 26);
    else g.rect(40, 590, 432, 90);
    g.fill();
    g.fillStyle = '#0B6B3A';
    g.font = '800 30px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText("IT'S YOUR TURN ✓", 256, 647);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
}

function Tag() {
  const ref = useRef<THREE.Group>(null);
  const tex = useTagTexture();
  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    ref.current.rotation.y = Math.sin(t * 0.6) * 0.45 + s.pointer.x * 0.25;
    ref.current.rotation.x = Math.sin(t * 0.4) * 0.08 - s.pointer.y * 0.15;
  });
  return (
    <group ref={ref}>
      <RoundedBox args={[2.2, 3.18, 0.14]} radius={0.12} smoothness={5}>
        <meshStandardMaterial color="#064726" metalness={0.25} roughness={0.4} />
      </RoundedBox>
      <mesh position={[0, 0, 0.0715]}>
        <planeGeometry args={[2.06, 2.98]} />
        <meshStandardMaterial map={tex} roughness={0.45} metalness={0.05} />
      </mesh>
      {/* lanyard clip */}
      <mesh position={[0, 1.75, 0]}>
        <torusGeometry args={[0.16, 0.05, 16, 40]} />
        <meshStandardMaterial color="#C9B783" metalness={0.8} roughness={0.25} />
      </mesh>
    </group>
  );
}

function Orb({ position, color, size }: { position: [number, number, number]; color: string; size: number }) {
  return (
    <Float speed={2} rotationIntensity={0.6} floatIntensity={1.4}>
      <mesh position={position}>
        <icosahedronGeometry args={[size, 1]} />
        <meshStandardMaterial color={color} roughness={0.3} metalness={0.2} flatShading />
      </mesh>
    </Float>
  );
}

export default function Hero3D() {
  return (
    <Canvas dpr={[1, 1.6]} camera={{ position: [0, 0, 6.2], fov: 42 }} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 5]} intensity={1.6} />
      <pointLight position={[-4, -2, 3]} intensity={18} color="#C9B783" />
      <Float speed={1.4} rotationIntensity={0.2} floatIntensity={0.6}>
        <Tag />
      </Float>
      <Orb position={[-1.9, 1.3, -0.6]} color="#E3F2E8" size={0.28} />
      <Orb position={[1.9, -1.2, -0.4]} color="#C9B783" size={0.22} />
      <Orb position={[1.7, 1.6, -1.2]} color="#0E7F46" size={0.34} />
      <Orb position={[-1.6, -1.7, -0.9]} color="#FFFFFF" size={0.18} />
    </Canvas>
  );
}
```

---

### `web/src/components/InstallGate.tsx`

```tsx
import { motion } from 'framer-motion';
import { useMemo, useState, type ReactNode } from 'react';
import { mustInstall, platform, promptInstall, useInstallState } from '../lib/install';
import { Button } from './ui';

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-green text-sm font-extrabold text-white">{n}</span>
      <span className="pt-1 text-sm">{children}</span>
    </li>
  );
}

const ShareIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="inline -mt-1" aria-label="Share">
    <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

/** On phones, CDS Pass only runs as an installed app (home-screen icon). */
export function InstallGate({ children }: { children: ReactNode }) {
  const needed = useMemo(mustInstall, []);
  const { canPrompt, justInstalled, standalone } = useInstallState();
  const [busy, setBusy] = useState(false);
  const p = useMemo(platform, []);

  if (!needed || standalone) return <>{children}</>;

  return (
    <div className="screen hero-green text-white">
      <div className="flex flex-1 flex-col px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
        <motion.div
          initial={{ y: 20, opacity: 0, rotate: -6 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 160, damping: 14 }}
          className="mx-auto"
        >
          <motion.img
            src="/icon-512.png"
            alt="CDS Pass"
            animate={{ y: [0, -8, 0] }}
            transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
            className="h-28 w-28 rounded-[30px] shadow-lift"
          />
        </motion.div>

        <h1 className="mt-6 text-center text-3xl font-extrabold leading-tight">Install CDS Pass</h1>
        <p className="mt-2 text-center text-green-mid">
          CDS Pass works as an app on your phone, so it can buzz you when your batch is called, even with the screen off.
        </p>

        <div className="mt-8 rounded-3xl bg-card p-5 text-ink shadow-lift">
          {justInstalled ? (
            <div className="space-y-2 text-center">
              <p className="text-lg font-extrabold text-green">Installed ✓</p>
              <p className="text-sm text-muted">Close this browser and open CDS Pass from your home screen.</p>
            </div>
          ) : p === 'inapp' ? (
            <ol className="space-y-4">
              <Step n={1}>You opened this link inside another app (like WhatsApp).</Step>
              <Step n={2}>
                Tap the <b>⋮</b> or <b>…</b> menu and choose <b>Open in Chrome</b> (or <b>Open in Safari</b> on iPhone).
              </Step>
              <Step n={3}>Then install CDS Pass from there.</Step>
            </ol>
          ) : p === 'ios' ? (
            <ol className="space-y-4">
              <Step n={1}>
                Open this page in <b>Safari</b>.
              </Step>
              <Step n={2}>
                Tap the <b>Share</b> button <ShareIcon /> at the bottom of the screen.
              </Step>
              <Step n={3}>
                Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
              </Step>
              <Step n={4}>Open CDS Pass from your home screen.</Step>
            </ol>
          ) : canPrompt ? (
            <div className="space-y-3">
              <Button
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await promptInstall();
                  setBusy(false);
                }}
              >
                Install app
              </Button>
              <p className="text-center text-xs text-muted">Free · about 1 MB · no Play Store needed</p>
            </div>
          ) : (
            <ol className="space-y-4">
              <Step n={1}>
                Tap the <b>⋮</b> menu at the top right of Chrome.
              </Step>
              <Step n={2}>
                Tap <b>Install app</b> or <b>Add to Home screen</b>.
              </Step>
              <Step n={3}>Open CDS Pass from your home screen.</Step>
            </ol>
          )}
        </div>

        <p className="mt-auto pt-8 text-center text-xs text-green-mid">
          On a laptop? CDS Pass works straight in the browser, no install needed.
        </p>
      </div>
    </div>
  );
}
```

---

### `web/src/components/MemberCard.tsx`

```tsx
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { PublicMember } from '../lib/types';
import { Avatar } from './Avatar';

/** Big photo + name + state code: what the exco compares with the NYSC ID card. */
export function MemberCard({
  member,
  tone = 'neutral',
  headline,
  detail,
  children,
}: {
  member: PublicMember;
  tone?: 'ok' | 'bad' | 'warn' | 'neutral';
  headline?: string;
  detail?: string;
  children?: ReactNode;
}) {
  const tones = {
    ok: 'bg-green text-white',
    bad: 'bg-bad text-white',
    warn: 'bg-warn-bg text-warn',
    neutral: 'bg-card text-ink',
  } as const;
  return (
    <motion.div
      initial={{ scale: 0.85, opacity: 0, rotateX: -20 }}
      animate={{ scale: 1, opacity: 1, rotateX: 0 }}
      exit={{ scale: 0.9, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      className={`rounded-[28px] p-5 shadow-lift [perspective:800px] ${tones[tone]}`}
    >
      {headline && <p className="text-center text-2xl font-extrabold">{headline}</p>}
      {detail && <p className="mt-0.5 text-center text-sm font-semibold opacity-90">{detail}</p>}
      <div className="mt-4 flex items-center gap-4 rounded-2xl bg-card p-3 text-ink">
        <Avatar src={member.photoURL} name={member.fullName} size={88} />
        <div className="min-w-0">
          <p className="text-lg font-extrabold leading-tight">{member.fullName}</p>
          <p className="font-semibold text-muted">{member.stateCode}</p>
          <p className="mt-1 text-xs font-bold text-green">Check this against the NYSC ID card</p>
        </div>
      </div>
      {children && <div className="mt-4 space-y-2">{children}</div>}
    </motion.div>
  );
}
```

---

### `web/src/components/PhotoPicker.tsx`

```tsx
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { compressPhoto } from '../lib/image';
import { Icon } from './ui';

/** Take a selfie or choose a photo. Returns a small, square JPEG. */
export function PhotoPicker({
  value,
  currentPhotoURL,
  onChange,
  onPickerOpen,
}: {
  value: Blob | null;
  currentPhotoURL?: string | null;
  onChange: (b: Blob | null, err?: string) => void;
  /** Called just before the camera/gallery opens (true) and when we're back (false). */
  onPickerOpen?: (open: boolean) => void;
}) {
  const cam = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return setPreview(null);
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  const [working, setWorking] = useState(false);

  function open(input: HTMLInputElement | null) {
    onPickerOpen?.(true);
    // If they cancel the camera/gallery no file arrives, but the page gets focus back.
    const back = () => {
      window.removeEventListener('focus', back);
      setTimeout(() => onPickerOpen?.(false), 500);
    };
    window.addEventListener('focus', back);
    input?.click();
  }

  async function pick(f: File | undefined) {
    onPickerOpen?.(false);
    if (!f) return;
    setWorking(true);
    try {
      onChange(await compressPhoto(f));
    } catch (e) {
      onChange(null, (e as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <motion.div
        initial={{ scale: 0.9, rotate: -4 }}
        animate={{ scale: 1, rotate: 0 }}
        className="relative h-40 w-40 overflow-hidden rounded-full bg-green-light shadow-lift ring-8 ring-white"
      >
        {working ? (
          <div className="grid h-full w-full place-items-center text-sm font-bold text-green">Preparing…</div>
        ) : preview || currentPhotoURL ? (
          <img src={preview ?? currentPhotoURL ?? undefined} alt="Your profile" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-green">
            <Icon name="user" size={64} />
          </div>
        )}
      </motion.div>
      <p className="max-w-xs text-center text-sm text-muted">
        Use a clear photo of your face. The exco compares it with your NYSC ID card.
      </p>
      <div className="grid w-full grid-cols-2 gap-3">
        <button type="button" onClick={() => open(cam.current)} disabled={working} className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-green font-bold text-white">
          <Icon name="camera" /> Take photo
        </button>
        <button type="button" onClick={() => open(gallery.current)} disabled={working} className="flex h-14 items-center justify-center gap-2 rounded-2xl border-2 border-green bg-card font-bold text-green">
          Choose photo
        </button>
      </div>
      <input ref={cam} type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}
```

---

### `web/src/components/PlatformChrome.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useAppStatus, usePlatformRole } from '../hooks/usePlatform';
import { Icon } from './ui';

/**
 * Floating mode switch for the CDS Pass admin team: 👤 User · 🧑‍💼 Exco · 🛡️ Admin.
 * Invisible to everyone else.
 */
export function ModeSwitch() {
  const role = usePlatformRole();
  const { profile } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  if (!role || !profile || profile.status !== 'approved') return null;

  const current = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/exco') ? 'exco' : 'user';
  const modes = [
    { id: 'user', label: 'User', icon: '👤', to: '/home' },
    ...(profile.role === 'exco' ? [{ id: 'exco', label: 'Exco', icon: '🧑‍💼', to: '/exco' }] : []),
    { id: 'admin', label: 'Admin', icon: '🛡️', to: '/admin' },
  ];
  const now = modes.find((m) => m.id === current) ?? modes[0];

  return (
    <div className="fixed right-3 top-[max(env(safe-area-inset-top),12px)] z-50 lg:right-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-full bg-gold px-3 text-xs font-extrabold text-[#3d2e00] shadow-lift"
        aria-label="Switch mode"
      >
        <span>{now.icon}</span> {now.label} <Icon name="chevron" size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            className="absolute right-0 mt-2 w-44 overflow-hidden rounded-2xl border border-line bg-card p-1.5 shadow-lift"
          >
            {modes.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setOpen(false);
                  nav(m.to);
                }}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-bold ${
                  m.id === current ? 'bg-green text-white' : 'text-ink hover:bg-green-light'
                }`}
              >
                <span>{m.icon}</span> {m.label} mode
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Announcement banner set in Admin mode (each person can close it once). */
export function AnnouncementBanner() {
  const status = useAppStatus();
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem('cdspass.bannerClosed') ?? '';
    } catch {
      return '';
    }
  });
  const text = status?.banner;
  if (!text || closed === text) return null;
  return (
    <div className="relative z-40 flex items-start gap-3 bg-gold px-4 py-2.5 text-sm font-semibold text-[#3d2e00]">
      <span>📣</span>
      <p className="flex-1">{text}</p>
      <button
        aria-label="Close announcement"
        onClick={() => {
          setClosed(text);
          try {
            localStorage.setItem('cdspass.bannerClosed', text);
          } catch {
            /* ignore */
          }
        }}
        className="font-extrabold"
      >
        ✕
      </button>
    </div>
  );
}

/** Full-screen notice while maintenance is on (the admin team can still get in). */
export function MaintenanceScreen({ children }: { children: ReactNode }) {
  const status = useAppStatus();
  const role = usePlatformRole();
  if (!status?.maintenance || role) return <>{children}</>;
  return (
    <div className="hero-green grid min-h-[100dvh] place-items-center px-6 text-center text-white">
      <div className="max-w-sm space-y-4">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-white/15 text-4xl">🛠️</div>
        <h1 className="text-2xl font-extrabold">CDS Pass is updating</h1>
        <p className="text-green-mid">{status.maintenance}</p>
        <button onClick={() => location.reload()} className="h-12 rounded-2xl bg-gold px-6 font-bold text-[#3d2e00]">
          Try again
        </button>
      </div>
    </div>
  );
}
```

---

### `web/src/components/QRScan.tsx`

```tsx
import QrScanner from 'qr-scanner';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from './ui';

interface Props {
  onResult: (text: string) => void;
  /** Stop reacting to codes (e.g. while a result card is showing). */
  paused?: boolean;
  className?: string;
}

/** Live camera QR scanner. Same code is ignored for 3 seconds so one scan = one action. */
export function QRScan({ onResult, paused = false, className = '' }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useRef(onResult);
  const pausedRef = useRef(paused);
  const last = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const scannerRef = useRef<QrScanner | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'on' | 'error'>('idle');
  const [error, setError] = useState('');

  cb.current = onResult;
  pausedRef.current = paused;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const scanner = new QrScanner(
      video,
      (r) => {
        if (pausedRef.current) return;
        const now = Date.now();
        if (r.data === last.current.text && now - last.current.at < 3000) return;
        last.current = { text: r.data, at: now };
        navigator.vibrate?.(60);
        cb.current(r.data);
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: 'environment',
        maxScansPerSecond: 6,
      },
    );
    scannerRef.current = scanner;
    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
  }, []);

  async function startCamera() {
    if (!window.isSecureContext) {
      setState('error');
      setError('Camera access requires HTTPS. Open the secure CDS Pass website, or type the door code.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setError(/WhatsApp|Instagram|FBAN|FBAV|; wv\)/i.test(navigator.userAgent)
        ? 'This in-app browser does not provide camera access. Open CDS Pass in Chrome or Safari, then try again.'
        : 'This browser does not support camera access. Open CDS Pass in an updated Chrome or Safari browser.');
      return;
    }
    setState('starting');
    setError('');
    try {
      await scannerRef.current?.start();
      setState('on');
    } catch (e) {
      setState('error');
      const err = e as { name?: string; message?: string };
      const msg = `${err.name ?? ''} ${err.message ?? e}`;
      setError(
        /NotAllowed|permission|denied/i.test(msg)
          ? 'Camera permission is blocked. Allow camera access for this website in your browser settings, then try again.'
          : /NotFound/i.test(msg)
            ? 'No camera was found on this device. Type the door code instead.'
            : /NotReadable|TrackStart/i.test(msg)
              ? 'The camera is busy in another app. Close that app and try again.'
              : `Could not open the camera. Check this site’s camera permission and try again. ${err.message ?? ''}`.trim(),
      );
    }
  }

  return (
    <div className={`relative mx-auto max-w-[480px] overflow-hidden rounded-3xl bg-green-deep ${className}`}>
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      {state === 'starting' && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner light size={32} />
        </div>
      )}
      {state !== 'on' && state !== 'starting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm font-semibold text-white">
          <p>{state === 'error' ? error : 'Tap below to let CDS Pass open your camera.'}</p>
          <button type="button" onClick={() => void startCamera()} className="rounded-xl bg-white px-5 py-3 font-bold text-green">
            {state === 'error' ? 'Try camera again' : 'Open camera'}
          </button>
        </div>
      )}
    </div>
  );
}
```

---

### `web/src/components/SideNav.tsx`

```tsx
import { motion } from 'framer-motion';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Avatar } from './Avatar';
import { excoTabs, memberTabs } from './BottomNav';
import { Icon } from './ui';

/** Laptop / desktop navigation (the bottom bar is used on phones). */
export function SideNav({ mode }: { mode: 'member' | 'exco' }) {
  const { profile, logout } = useAuth();
  const tabs = mode === 'exco' ? [...excoTabs, { to: '/exco/dues', label: 'Dues', icon: 'card' }, { to: '/exco/settings', label: 'Settings', icon: 'settings' }] : memberTabs;

  return (
    <aside className="no-print sticky top-0 hidden h-[100dvh] w-[280px] shrink-0 flex-col border-r border-line bg-card px-5 py-6 lg:flex">
      <Link to={mode === 'exco' ? '/exco' : '/home'} className="flex items-center gap-3 px-2">
        <img src="/icon.svg" alt="" className="h-10 w-10 rounded-2xl" />
        <div>
          <p className="font-extrabold leading-tight">CDS Pass</p>
          <p className="text-xs font-semibold text-muted">{mode === 'exco' ? 'Exco tools' : 'Corps member'}</p>
        </div>
      </Link>

      <nav className="mt-8 flex flex-col gap-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/exco'}
            className={({ isActive }) =>
              `relative flex h-12 items-center gap-3 rounded-2xl px-4 text-sm font-bold transition-colors ${
                isActive ? 'text-white' : 'text-muted hover:bg-green-light hover:text-green'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId={`side-${mode}`}
                    className="absolute inset-0 rounded-2xl bg-green shadow-card"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">
                  <Icon name={t.icon} size={20} />
                </span>
                <span className="relative">{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {profile?.role === 'exco' && (
        <Link
          to={mode === 'exco' ? '/home' : '/exco'}
          className="mt-6 flex h-12 items-center justify-center gap-2 rounded-2xl border-2 border-line text-sm font-bold text-green"
        >
          <Icon name={mode === 'exco' ? 'tag' : 'grid'} size={18} />
          {mode === 'exco' ? 'My own tag' : 'Exco mode'}
        </Link>
      )}

      <div className="mt-auto flex items-center gap-3 rounded-2xl bg-paper p-3">
        {profile && <Avatar src={profile.photoURL} name={profile.fullName} size={40} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{profile?.fullName}</p>
          <p className="truncate text-xs text-muted">{profile?.stateCode}</p>
        </div>
        <button onClick={logout} aria-label="Log out" className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-line">
          <Icon name="logout" size={18} />
        </button>
      </div>
    </aside>
  );
}
```

---

### `web/src/components/TagCard3D.tsx`

```tsx
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { memberQR } from '../lib/rules';
import { Avatar } from './Avatar';

interface Props {
  uid: string;
  name: string;
  stateCode: string;
  photoURL: string | null;
  groupName?: string;
  /** "14", "P2", or null when not checked in today */
  tag: string | null;
  status: 'none' | 'waiting' | 'turn' | 'done';
}

/**
 * The member's tag as a 3D card: tilts with the phone (or finger),
 * tap to flip to the big QR the exco scans at the table.
 */
export function TagCard3D({ uid, name, stateCode, photoURL, groupName, tag, status }: Props) {
  const [flipped, setFlipped] = useState(false);
  const flippedRef = useRef(false);
  flippedRef.current = flipped;
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 150, damping: 18 });
  const sry = useSpring(ry, { stiffness: 150, damping: 18 });
  const glareX = useTransform(sry, [-14, 14], ['10%', '90%']);

  // Gentle tilt from the phone's motion sensor (Android; iPhone needs a permission tap).
  useEffect(() => {
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      if (flippedRef.current) return;
      rx.set(Math.max(-10, Math.min(10, (e.beta - 45) / 4)));
      ry.set(Math.max(-12, Math.min(12, e.gamma / 3)));
    };
    window.addEventListener('deviceorientation', onTilt);
    return () => window.removeEventListener('deviceorientation', onTilt);
  }, [rx, ry]);

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (flipped) return;
    const r = e.currentTarget.getBoundingClientRect();
    ry.set(((e.clientX - r.left) / r.width - 0.5) * 24);
    rx.set(-((e.clientY - r.top) / r.height - 0.5) * 18);
  };
  const reset = () => {
    rx.set(0);
    ry.set(0);
  };

  // Flat while showing the QR so it scans easily.
  useEffect(() => {
    if (flipped) {
      rx.set(0);
      ry.set(0);
    }
  }, [flipped, rx, ry]);

  const statusUi = {
    none: { text: 'Not checked in today', cls: 'bg-white/15 text-white' },
    waiting: { text: 'Waiting for your batch', cls: 'bg-khaki text-green-deep' },
    turn: { text: "It's your turn — go now", cls: 'theme-light bg-white text-green' },
    done: { text: 'Thumbprinted ✓', cls: 'theme-light bg-white text-green' },
  }[status];

  return (
    <div className="mx-auto w-full max-w-[340px] [perspective:1200px]">
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show tag number' : 'Show QR code'}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setFlipped((f) => !f)}
        onPointerMove={onMove}
        onPointerLeave={reset}
        style={{ rotateX: srx, rotateY: sry, transformStyle: 'preserve-3d' }}
        animate={status === 'turn' && !flipped ? { scale: [1, 1.03, 1] } : { scale: 1 }}
        transition={status === 'turn' && !flipped ? { repeat: Infinity, duration: 1.4 } : { duration: 0.3 }}
        className="relative aspect-[5/7] w-full cursor-pointer select-none"
      >
        <motion.div
          className="absolute inset-0"
          style={{ transformStyle: 'preserve-3d' }}
          animate={{ rotateY: flipped ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 16 }}
        >
        {/* FRONT */}
        <div
          className="absolute inset-0 overflow-hidden rounded-[28px] bg-gradient-to-br from-green via-green to-green-dark p-6 text-white shadow-lift [backface-visibility:hidden]"
          style={{ transform: 'translateZ(1px)' }}
        >
          <div className="grid-bg absolute inset-0 opacity-60" />
          <motion.div
            className="pointer-events-none absolute -inset-1/2 rotate-12 bg-gradient-to-r from-transparent via-white/25 to-transparent"
            style={{ left: glareX }}
          />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between">
              <span className="text-sm font-extrabold tracking-widest">CDS PASS</span>
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">{groupName ?? 'CDS'}</span>
            </div>

            <div className="mt-5 flex items-center gap-3" style={{ transform: 'translateZ(30px)' }}>
              <Avatar src={photoURL} name={name} size={64} ring />
              <div className="min-w-0">
                <p className="truncate text-lg font-extrabold leading-tight">{name}</p>
                <p className="text-sm font-semibold text-green-mid">{stateCode}</p>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center" style={{ transform: 'translateZ(60px)' }}>
              <span className="text-xs font-bold tracking-[0.3em] text-green-mid">YOUR NUMBER</span>
              <span
                className="text-[110px] font-extrabold leading-none"
                style={{ textShadow: '0 2px 0 #075a30, 0 4px 0 #064726, 0 6px 0 #053d20, 0 14px 30px rgba(0,0,0,.35)' }}
              >
                {tag ?? '—'}
              </span>
            </div>

            <div className={`rounded-2xl px-4 py-3 text-center text-sm font-extrabold ${statusUi.cls}`}>{statusUi.text}</div>
            <p className="mt-2 text-center text-[11px] font-semibold text-green-mid">Tap to show QR</p>
          </div>
        </div>

        {/* BACK */}
        <div
          className="theme-light absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-[28px] bg-white p-6 shadow-lift [backface-visibility:hidden]"
          style={{ transform: 'rotateY(180deg) translateZ(1px)' }}
        >
          <span className="text-sm font-extrabold tracking-widest text-green">SHOW THIS TO THE EXCO</span>
          <div className="rounded-3xl bg-white p-3 ring-4 ring-green-light">
            <QRCodeSVG value={memberQR(uid)} size={220} level="M" fgColor="#03301A" />
          </div>
          <div className="text-center">
            <p className="text-3xl font-extrabold text-green">{tag ?? '—'}</p>
            <p className="text-sm font-semibold text-muted">
              {name} · {stateCode}
            </p>
          </div>
        </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
```

---

### `web/src/components/ThemeToggle.tsx`

```tsx
import { setThemeMode, useThemeMode, type ThemeMode } from '../lib/theme';

const options: { id: ThemeMode; label: string; icon: string }[] = [
  { id: 'system', label: 'Auto', icon: 'M12 3a9 9 0 1 0 0 18V3z' },
  { id: 'light', label: 'Light', icon: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4' },
  { id: 'dark', label: 'Dark', icon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' },
];

/** Auto (follows the phone), Light, Dark. */
export function ThemeToggle() {
  const mode = useThemeMode();
  return (
    <div className="space-y-2">
      <p className="font-bold">Appearance</p>
      <p className="text-sm text-muted">Auto follows your phone's light or dark setting.</p>
      <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-line p-1.5" role="radiogroup" aria-label="Appearance">
        {options.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={mode === o.id}
            onClick={() => setThemeMode(o.id)}
            className={`flex h-12 items-center justify-center gap-2 rounded-xl text-sm font-bold transition-colors ${
              mode === o.id ? 'bg-card text-green shadow-card' : 'text-muted'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={o.icon} />
            </svg>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

---

### `web/src/components/Toaster.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { dismiss, subscribeToasts, type ToastItem } from '../lib/toast';

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 mx-auto flex max-w-md flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ opacity: 0, y: -30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto rounded-2xl px-4 py-3 text-left shadow-lift ${
              t.kind === 'error' ? 'bg-bad text-white' : t.kind === 'success' ? 'bg-green text-white' : 'bg-ink text-white'
            }`}
          >
            <p className="font-bold">{t.title}</p>
            {t.body ? <p className="text-sm opacity-90">{t.body}</p> : null}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
```

---

### `web/src/components/ui.tsx`

```tsx
import { AnimatePresence, motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'light' | 'gold';

const variants: Record<Variant, string> = {
  primary: 'bg-green text-white shadow-[0_8px_0_#064726] active:shadow-[0_3px_0_#064726] active:translate-y-[5px]',
  outline: 'border-2 border-green bg-card text-green',
  ghost: 'bg-green-light text-green',
  danger: 'bg-bad text-white shadow-[0_8px_0_#7A1810] active:shadow-[0_3px_0_#7A1810] active:translate-y-[5px]',
  light: 'bg-card text-green shadow-[0_8px_0_rgb(var(--line))] active:shadow-[0_3px_0_rgb(var(--line))] active:translate-y-[5px]',
  gold: 'bg-gold text-[#3d2e00] shadow-[0_8px_0_#B39B5A] active:shadow-[0_3px_0_#B39B5A] active:translate-y-[5px]',
};

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  loading?: boolean;
  children: ReactNode;
  full?: boolean;
}

/** Chunky 3D-press button. */
export function Button({ variant = 'primary', loading, children, full = true, className = '', disabled, ...rest }: ButtonProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      disabled={disabled || loading}
      className={`flex h-14 items-center justify-center gap-2 rounded-2xl px-5 text-base font-bold transition-[transform,box-shadow] disabled:opacity-50 ${
        full ? 'w-full' : ''
      } ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner light={variant === 'primary' || variant === 'danger'} /> : children}
    </motion.button>
  );
}

export function Spinner({ light = false, size = 22 }: { light?: boolean; size?: number }) {
  return (
    <motion.span
      aria-label="Loading"
      role="status"
      className={`inline-block rounded-full border-[3px] ${light ? 'border-white/30 border-t-white' : 'border-green/20 border-t-green'}`}
      style={{ width: size, height: size }}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
    />
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, error, id, ...rest }, ref) {
  const fid = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={fid} className="label">
        {label}
      </label>
      <input ref={ref} id={fid} className={`input ${error ? 'border-bad' : ''}`} {...rest} />
      {error ? (
        <p className="mt-1.5 text-sm font-semibold text-bad">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-muted">{hint}</p>
      ) : null}
    </div>
  );
});

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <motion.p
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="alert"
      className="rounded-2xl bg-bad-bg px-4 py-3 text-sm font-semibold text-bad"
    >
      {children}
    </motion.p>
  );
}

export function Pill({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'warn' | 'bad' | 'muted' | 'white' | 'gold' }) {
  const tones = {
    gold: 'bg-gold-bg text-gold-text',
    green: 'bg-green-light text-green',
    warn: 'bg-warn-bg text-warn',
    bad: 'bg-bad-bg text-bad',
    muted: 'bg-line text-muted',
    white: 'bg-white/15 text-white',
  } as const;
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

/** Green top bar with optional back button. */
export function TopBar({ title, back, right, sub }: { title: string; back?: string | true; right?: ReactNode; sub?: string }) {
  const nav = useNavigate();
  return (
    <header className="hero-green sticky top-0 z-20 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white backdrop-blur lg:top-4 lg:rounded-3xl lg:px-6 lg:pt-4">
      <div className="flex items-center gap-3">
        {back ? (
          typeof back === 'string' ? (
            <Link to={back} aria-label="Back" className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
              <Icon name="back" />
            </Link>
          ) : (
            <button aria-label="Back" onClick={() => nav(-1)} className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
              <Icon name="back" />
            </button>
          )
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-extrabold">{title}</h1>
          {sub ? <p className="truncate text-xs font-medium text-green-mid">{sub}</p> : null}
        </div>
        {right}
      </div>
    </header>
  );
}

/** Page wrapper with a soft slide-in. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.main
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28 }}
      className={`flex-1 px-4 pb-28 pt-4 lg:px-0 lg:pb-10 lg:pt-6 ${className}`}
    >
      {children}
    </motion.main>
  );
}

export function Stat({ value, label, tone = 'dark' }: { value: ReactNode; label: string; tone?: 'dark' | 'light' | 'gold' }) {
  return (
    <div
      className={`rounded-2xl p-3 ${
        tone === 'dark' ? 'bg-white/10 text-white' : tone === 'gold' ? 'bg-gold text-[#3d2e00]' : 'bg-white text-ink shadow-card'
      }`}
    >
      <div className="font-display text-2xl font-extrabold leading-tight">{value}</div>
      <div className={`text-xs font-semibold ${tone === 'dark' ? 'text-green-mid' : tone === 'gold' ? 'opacity-75' : 'text-muted'}`}>{label}</div>
    </div>
  );
}

const paths: Record<string, ReactNode> = {
  back: <path d="m15 18-6-6 6-6" />,
  home: <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  scan: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </>
  ),
  tag: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M9 8h6M8 16h8M10 12h4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 9M22 21a7 7 0 0 0-4-6.3" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  door: (
    <>
      <path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M2 21h20" />
      <circle cx="12.5" cy="12" r="1" />
    </>
  ),
  megaphone: (
    <>
      <path d="m3 11 15-6v14L3 13z" />
      <path d="M7 13v5a2 2 0 0 0 4 0v-3.5" />
    </>
  ),
  finger: <path d="M12 11v3m-4-4a4 4 0 0 1 8 0v4a8 8 0 0 1-1 4M5 8a8 8 0 0 1 14 0m-3 12a12 12 0 0 0 1-6M8 14a4 4 0 0 0 1 3" />,
  check: <path d="M20 6 9 17l-5-5" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  pin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  keypad: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" />
    </>
  ),
  print: (
    <>
      <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  cash: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  bank: <path d="M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 22, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}


/* ------------------------------------------------------------------ */
/* Select: our own dropdown (no grey browser box).                     */
/* ------------------------------------------------------------------ */

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Styled dropdown. Tap to open a list that slides in; tap an option to choose.
 * With more than 8 options a search box appears (e.g. the list of banks).
 * Closes on outside tap or Escape. Arrow keys + Enter work on laptops.
 */
export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  label,
  size = 'md',
  disabled,
  inline = false,
  className = '',
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  label?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Open the list in the page flow instead of floating over it (use inside boxes that clip their content). */
  inline?: boolean;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const searchable = options.length > 8;
  const current = options.find((o) => o.value === value);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, options, value]);

  function pick(o: SelectOption<T>) {
    onChange(o.value);
    setOpen(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') return setOpen(false);
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      return setOpen(true);
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(shown.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter' && shown[hi]) {
      e.preventDefault();
      pick(shown[hi]);
    }
  }

  const h = size === 'sm' ? 'h-10 rounded-xl px-3 text-sm' : 'h-14 rounded-2xl px-4 text-base';

  return (
    <div ref={box} className={`relative ${className}`} onKeyDown={onKey}>
      {label && (
        <label htmlFor={id} className="label">
          {label}
        </label>
      )}
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 border-2 bg-card font-semibold text-ink outline-none transition disabled:opacity-50 ${h} ${
          open ? 'border-green shadow-[0_0_0_4px_rgb(var(--green-light))]' : 'border-line hover:border-green/50'
        }`}
      >
        <span className={`truncate ${current ? '' : 'text-muted'}`}>{current?.label ?? placeholder}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="shrink-0 text-green">
          <Icon name="chevron" size={size === 'sm' ? 16 : 20} />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className={`${inline ? 'relative' : 'absolute left-0 right-0 z-40 min-w-[11rem] shadow-lift'} mt-2 overflow-hidden rounded-2xl border border-line bg-card`}
          >
            {searchable && (
              <div className="border-b border-line p-2">
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setHi(0);
                  }}
                  placeholder="Search…"
                  className="h-11 w-full rounded-xl bg-paper px-3 text-sm text-ink outline-none"
                />
              </div>
            )}
            <ul role="listbox" className="max-h-72 overflow-y-auto overscroll-contain p-1.5">
              {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nothing found</li>}
              {shown.map((o, i) => {
                const selected = o.value === value;
                return (
                  <li key={o.value} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      onMouseEnter={() => setHi(i)}
                      onClick={() => pick(o)}
                      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                        selected ? 'bg-green text-white' : i === hi ? 'bg-green-light text-green' : 'text-ink'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{o.label}</span>
                        {o.hint && <span className={`block text-xs font-normal ${selected ? 'text-green-mid' : 'text-muted'}`}>{o.hint}</span>}
                      </span>
                      {selected && <Icon name="check" size={16} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Checkbox: our own tick box.                                          */
/* ------------------------------------------------------------------ */

export function Checkbox({
  checked,
  onChange,
  children,
  className = '',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex cursor-pointer gap-3 ${className}`}>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border-2 transition-colors peer-focus-visible:ring-4 peer-focus-visible:ring-green-light ${
          checked ? 'border-green bg-green text-white' : 'border-line bg-card'
        }`}
      >
        <AnimatePresence>
          {checked && (
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 25 }}>
              <Icon name="check" size={15} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className="min-w-0">{children}</span>
    </label>
  );
}
```

---

### `web/src/hooks/useAuth.tsx`

```tsx
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { clearDraft } from '../lib/signupDraft';
import { doc, onSnapshot } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth, db } from '../lib/firebase';
import type { Profile } from '../lib/types';

interface Claims {
  gid?: string;
  role?: 'member' | 'exco';
  approved?: boolean;
}

interface AuthState {
  /** undefined = still loading */
  user: User | null | undefined;
  /** undefined = loading, null = account exists but registration not finished */
  profile: Profile | null | undefined;
  /** A read failure is different from a profile that does not exist. */
  profileError: string | null;
  claims: Claims;
  /** true when the login token already carries the approval (needed for reading group data) */
  ready: boolean;
  refreshClaims: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [claims, setClaims] = useState<Claims>({});

  const refreshClaims = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return setClaims({});
    const t = await u.getIdTokenResult(true);
    setClaims({ gid: t.claims.gid as string, role: t.claims.role as Claims['role'], approved: t.claims.approved === true });
  }, []);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        setUser(u);
        if (!u) {
          setProfile(null);
          setProfileError(null);
          setClaims({});
          return;
        }
        // A login saved in the browser can point to an account that no longer exists
        // (deleted, or the local test server was restarted). Log out instead of getting stuck.
        try {
          await u.reload();
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'auth/user-not-found' || code === 'auth/user-token-expired' || code === 'auth/user-disabled') {
            await signOut(auth);
            return;
          }
        }
        try {
          const t = await u.getIdTokenResult();
          setClaims({ gid: t.claims.gid as string, role: t.claims.role as Claims['role'], approved: t.claims.approved === true });
        } catch (e) {
          // Offline at start-up: the refresh below (or the "Try again" screen) picks the claims up later.
          console.warn('Could not read login permissions yet.', e);
        }
      }),
    [],
  );

  useEffect(() => {
    if (!user) {
      setProfileError(null);
      return;
    }
    setProfile(undefined);
    setProfileError(null);
    return onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        setProfileError(null);
        setProfile(snap.exists() ? ({ uid: snap.id, ...snap.data() } as Profile) : null);
      },
      (error) => {
        console.error('Could not load the signed-in user profile:', error);
        setProfile(undefined);
        setProfileError(error.message || 'Could not read your CDS profile.');
      },
    );
  }, [user]);

  // When an exco approves you (or changes your role), pick up the new permissions.
  useEffect(() => {
    if (!profile) return;
    const approved = profile.status === 'approved';
    if (approved !== !!claims.approved || (approved && profile.role !== claims.role)) {
      void refreshClaims();
    }
  }, [profile, claims.approved, claims.role, refreshClaims]);

  const ready =
    !!profile && profile.status === 'approved' && claims.approved === true && claims.role === profile.role;

  const logout = useCallback(async () => {
    clearDraft();
    await signOut(auth);
  }, []);

  return <Ctx.Provider value={{ user, profile, profileError, claims, ready, refreshClaims, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

/** For screens that only render once signed in and approved. */
export function useMe(): Profile {
  const { profile } = useAuth();
  if (!profile) throw new Error('useMe used before profile loaded');
  return profile;
}
```

---

### `web/src/hooks/useExco.ts`

```ts
import { useMemo } from 'react';
import { useMe } from './useAuth';
import { useAttendees, useGroup, useSession } from './useLive';

/** Live numbers for the exco screens. */
export function useExcoDay() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const session = useSession(me.groupId);
  const attendees = useAttendees(me.groupId);

  const stats = useMemo(() => {
    const list = attendees ?? [];
    return {
      present: list.length,
      done: list.filter((a) => a.status === 'done').length,
      waiting: list.filter((a) => a.status === 'waiting').length,
      priority: list.filter((a) => a.priority).length,
      priorityWaiting: list.filter((a) => a.priority && a.status === 'waiting').length,
      manual: list.filter((a) => a.method === 'manual').length,
    };
  }, [attendees]);

  return { me, group, session, attendees, stats, open: session?.status === 'open' };
}
```

---

### `web/src/hooks/useLive.ts`

```ts
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/firebase';
import { api } from '../lib/api';
import { lagosDate } from '../lib/rules';
import type { Attendee, Dues, DuesStatus, Group, LogEntry, Payment, Profile, Session } from '../lib/types';

/** Live document. undefined = loading, null = does not exist. */
export function useDoc<T>(path: string | null): T | null | undefined {
  const [val, setVal] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    if (!path) return setVal(null);
    setVal(undefined);
    return onSnapshot(
      doc(db, path),
      (s) => setVal(s.exists() ? ({ id: s.id, ...s.data() } as T) : null),
      (e) => {
        console.warn(path, e);
        setVal(null);
      },
    );
  }, [path]);
  return val;
}

/** Live list. undefined = loading. */
export function useList<T>(q: Query<DocumentData> | null, key: string): T[] | undefined {
  const [val, setVal] = useState<T[] | undefined>(undefined);
  useEffect(() => {
    if (!q) return setVal([]);
    setVal(undefined);
    return onSnapshot(
      q,
      (s) => setVal(s.docs.map((d) => ({ id: d.id, uid: d.id, ...d.data() }) as T)),
      (e) => {
        console.warn(key, e);
        setVal([]);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return val;
}

/** Today's date in Lagos, refreshed every minute so the app rolls over at midnight. */
export function useToday(): string {
  const [d, setD] = useState(lagosDate());
  useEffect(() => {
    const t = setInterval(() => setD(lagosDate()), 60_000);
    return () => clearInterval(t);
  }, []);
  return d;
}

export const useGroup = (gid: string | undefined) => useDoc<Group>(gid ? `groups/${gid}` : null);

export function useSession(gid: string | undefined) {
  const today = useToday();
  return useDoc<Session>(gid ? `groups/${gid}/sessions/${today}` : null);
}

export function useMyAttendee(gid: string | undefined, uid: string | undefined) {
  const today = useToday();
  return useDoc<Attendee>(gid && uid ? `groups/${gid}/sessions/${today}/attendees/${uid}` : null);
}

export function useAttendees(gid: string | undefined) {
  const today = useToday();
  const q = useMemo(
    () => (gid ? query(collection(db, `groups/${gid}/sessions/${today}/attendees`)) : null),
    [gid, today],
  );
  const list = useList<Attendee>(q, `att:${gid}:${today}`);
  return useMemo(
    () =>
      list?.slice().sort((a, b) => {
        if (a.priority !== b.priority) return a.priority ? -1 : 1;
        if (a.priority && b.priority) return (a.pNumber ?? 0) - (b.pNumber ?? 0);
        return a.number - b.number;
      }),
    [list],
  );
}

export function useGroupMembers(gid: string | undefined) {
  const q = useMemo(() => (gid ? query(collection(db, 'users'), where('groupId', '==', gid)) : null), [gid]);
  const list = useList<Profile>(q, `members:${gid}`);
  return useMemo(() => list?.slice().sort((a, b) => a.fullName.localeCompare(b.fullName)), [list]);
}

/** Only the members waiting for approval: far fewer reads than loading the whole group. */
export function usePendingMembers(gid: string | undefined) {
  const q = useMemo(
    () => (gid ? query(collection(db, 'users'), where('groupId', '==', gid), where('status', '==', 'pending')) : null),
    [gid],
  );
  return useList<Profile>(q, `pending:${gid}`);
}

export function useLogs(gid: string | undefined, max = 50) {
  const [logs, setLogs] = useState<LogEntry[] | undefined>(undefined);
  useEffect(() => {
    if (!gid) {
      setLogs([]);
      return;
    }
    let active = true;
    setLogs(undefined);
    void api.getLogs({ limit: max }).then((entries) => {
      if (active) setLogs(entries);
    }).catch((error) => {
      console.error('Could not load activity history.', error);
      if (active) setLogs([]);
    });
    return () => { active = false; };
  }, [gid, max]);
  return logs;
}

export function useActiveDues(gid: string | undefined) {
  const q = useMemo(() => (gid ? query(collection(db, `groups/${gid}/dues`), where('active', '==', true)) : null), [gid]);
  const list = useList<Dues>(q, `dues:${gid}`);
  return useMemo(() => list?.slice().sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)), [list]);
}

export function useDuesStatuses(gid: string | undefined, duesId: string | undefined) {
  const q = useMemo(
    () => (gid && duesId ? query(collection(db, `groups/${gid}/dues/${duesId}/status`)) : null),
    [gid, duesId],
  );
  return useList<DuesStatus>(q, `duesStatus:${gid}:${duesId}`);
}

export function useMyPayments(gid: string | undefined, uid: string | undefined) {
  const q = useMemo(
    () => (gid && uid ? query(collection(db, `groups/${gid}/payments`), where('uid', '==', uid)) : null),
    [gid, uid],
  );
  const list = useList<Payment>(q, `pay:${gid}:${uid}`);
  return useMemo(
    () =>
      list
        ?.filter((p) => p.status === 'paid')
        .sort((a, b) => (b.paidAt?.toMillis() ?? 0) - (a.paidAt?.toMillis() ?? 0)),
    [list],
  );
}
```

---

### `web/src/hooks/useMyDay.ts`

```ts
import { useEffect, useRef } from 'react';
import { isTurn, tagLabel } from '../lib/rules';
import { batchTurnToast } from '../lib/toast';
import { useMe } from './useAuth';
import { useGroup, useMyAttendee, useSession } from './useLive';

/** Everything a member needs for today: group, session, my tag and whether it's my turn. */
export function useMyDay() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const session = useSession(me.groupId);
  const att = useMyAttendee(me.groupId, me.uid);

  const turn = session?.status === 'open' && !!att && isTurn(att, session.batch);
  const status: 'none' | 'waiting' | 'turn' | 'done' = !att ? 'none' : att.status === 'done' ? 'done' : turn ? 'turn' : 'waiting';

  // Buzz the phone the moment my batch is called (works whenever the site is open).
  const wasTurn = useRef(turn);
  useEffect(() => {
    if (turn && !wasTurn.current) {
      navigator.vibrate?.([400, 150, 400, 150, 400]);
      batchTurnToast("It's your turn!", 'Go to the thumbprint table and show your tag.');
    }
    wasTurn.current = turn;
  }, [turn]);

  return { me, group, session, att, turn, status, tag: att ? tagLabel(att) : null };
}
```

---

### `web/src/hooks/usePlatform.ts`

```ts
import { useEffect, useState } from 'react';
import { api, type PlatformRole } from '../lib/api';
import { useAuth } from './useAuth';

/** The admin-team role for the logged-in user (null for normal users). Asked once per login. */
let cache: { uid: string; role: PlatformRole | null } | null = null;

export function usePlatformRole(): PlatformRole | null {
  const { user } = useAuth();
  const [role, setRole] = useState<PlatformRole | null>(cache && user && cache.uid === user.uid ? cache.role : null);
  useEffect(() => {
    if (!user) return;
    const known = cache;
    if (known && known.uid === user.uid) {
      setRole(known.role);
      return;
    }
    let live = true;
    api
      .adminWhoAmI({})
      .then((r) => {
        cache = { uid: user.uid, role: r.role };
        if (live) setRole(r.role);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [user]);
  return role;
}

/** Public app status: banner + maintenance (fetched once, never blocks the app). */
type Status = Awaited<ReturnType<typeof api.appStatus>>;
let statusPromise: Promise<Status> | null = null;

export function useAppStatus(): Status | null {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    statusPromise ??= api.appStatus({});
    let live = true;
    statusPromise.then((v) => live && setS(v)).catch(() => (statusPromise = null));
    return () => {
      live = false;
    };
  }, []);
  return s;
}
```

---

### `web/src/index.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* ---------- Theme colours (RGB triplets) ---------- */
:root,
.theme-light {
  --paper: 243 247 242;
  --card: 255 255 255;
  --ink: 16 35 26;
  --muted: 74 94 83;
  --line: 220 232 223;
  --green: 11 107 58;
  --green-text: 11 107 58;
  --green-light: 227 242 232;
  --warn: 138 90 0;
  --warn-bg: 255 244 214;
  --bad-text: 180 35 24;
  --bad-bg: 253 231 229;
  --shadow: 11 107 58;
  --gold-bg: 247 240 218;
  --gold-text: 107 82 0;
  color-scheme: light;
}

.dark {
  --paper: 9 20 14;
  --card: 18 33 25;
  --ink: 231 241 234;
  --muted: 157 179 166;
  --line: 38 58 46;
  --green: 16 133 74;
  --green-text: 74 199 134;
  --green-light: 22 55 37;
  --warn: 242 196 107;
  --warn-bg: 58 46 16;
  --bad-text: 252 129 120;
  --bad-bg: 61 23 20;
  --shadow: 0 0 0;
  --gold-bg: 52 45 22;
  --gold-text: 230 211 154;
  color-scheme: dark;
}

/* Things that must stay white (QR codes, printed cards) keep light colours even in dark mode. */
.dark .theme-light {
  --paper: 243 247 242;
  --card: 255 255 255;
  --ink: 16 35 26;
  --muted: 74 94 83;
  --line: 220 232 223;
  --green: 11 107 58;
  --green-text: 11 107 58;
  --green-light: 227 242 232;
  --warn: 138 90 0;
  --warn-bg: 255 244 214;
  --bad-text: 180 35 24;
  --bad-bg: 253 231 229;
  --gold-bg: 247 240 218;
  --gold-text: 107 82 0;
  color-scheme: light;
}

@layer base {
  h1,
  h2,
  h3,
  .font-display {
    font-family: 'Poppins', 'Plus Jakarta Sans', system-ui, sans-serif;
    letter-spacing: -0.01em;
  }
  html,
  body,
  #root {
    min-height: 100%;
  }
  body {
    @apply bg-paper text-ink font-sans antialiased transition-colors duration-300;
    -webkit-tap-highlight-color: transparent;
  }
  input,
  select,
  textarea,
  button {
    font: inherit;
  }
  ::placeholder {
    color: rgb(var(--muted) / 0.6);
  }
}

@layer components {
  /* Stand-alone pages (welcome, sign up, log in, pending): full screen on phones,
     a framed "app window" on laptops. */
  .screen {
    @apply mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-paper lg:my-8 lg:min-h-[calc(100dvh-4rem)] lg:overflow-hidden lg:rounded-[32px] lg:shadow-lift;
  }
  .card {
    @apply rounded-3xl bg-card p-5 shadow-card;
  }
  .label {
    @apply mb-1.5 block text-sm font-semibold text-muted;
  }
  .input {
    @apply h-14 w-full rounded-2xl border-2 border-line bg-card px-4 text-base text-ink outline-none transition focus:border-green;
  }
  /* Our green header: deep NYSC green with a soft gold glow in the corner and faint dots. */
  .hero-green {
    background-color: #064726;
    background-image: radial-gradient(circle at 92% -10%, rgba(217, 197, 138, 0.38), transparent 42%),
      radial-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px),
      linear-gradient(155deg, #053d20 0%, #0b6b3a 62%, #0e7f47 100%);
    background-size: 100% 100%, 18px 18px, 100% 100%;
  }
  /* Big green "your number" card */
  .number-card {
    background-image: radial-gradient(circle at 100% 0%, rgba(255, 255, 255, 0.12), transparent 45%),
      linear-gradient(150deg, #10854a 0%, #0b6b3a 60%, #075230 100%);
    box-shadow: 0 22px 44px -20px rgba(11, 107, 58, 0.75);
  }
  .grid-bg {
    background-image: radial-gradient(rgba(255, 255, 255, 0.09) 1px, transparent 1px);
    background-size: 18px 18px;
  }
}

@keyframes turn-glow {
  0%, 100% { box-shadow: 0 22px 44px -20px rgba(11, 107, 58, 0.75), 0 0 0 0 rgba(217, 197, 138, 0.0); }
  50% { box-shadow: 0 22px 44px -20px rgba(11, 107, 58, 0.75), 0 0 0 10px rgba(217, 197, 138, 0.35); }
}
.turn-glow {
  animation: turn-glow 1.8s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .turn-glow { animation: none; }
}

/* Text colours that need a lighter shade on dark backgrounds. */
.text-green {
  color: rgb(var(--green-text));
}
.text-bad {
  color: rgb(var(--bad-text));
}

/* Laptop backdrop behind the framed pages */
@media (min-width: 1024px) {
  body {
    background-color: #03301a;
    background-image: radial-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px),
      radial-gradient(circle at 20% 20%, rgba(14, 127, 70, 0.55), transparent 55%);
    background-size: 22px 22px, 100% 100%;
  }
}

/* Printed member cards */
@media print {
  .no-print {
    display: none !important;
  }
  body {
    background: #fff !important;
  }
  .print-grid {
    display: grid !important;
    grid-template-columns: repeat(2, 1fr);
    gap: 8mm;
  }
  .print-card {
    break-inside: avoid;
    box-shadow: none !important;
    border: 1px solid #0b6b3a;
  }
}

/* QR scanner highlight */
.scan-region-highlight-svg,
.code-outline-highlight {
  stroke: #e3f2e8 !important;
}
```

---

### `web/src/lib/api.ts`

```ts
import { callable } from './firebase';
import type { Attendee, Batch, LogEntry, PublicMember, TableCheckResponse } from './types';

interface ProfileInput {
  stateCode: string;
  fullName: string;
  phone: string;
  photoURL: string | null;
}
type Who = { uid?: string; stateCode?: string };

export const api = {
  getLogs: callable<{ limit: number }, LogEntry[]>('getLogs'),
  // accounts
  registerMember: callable<ProfileInput & { joinCode: string }, { ok: true; status: 'pending' | 'approved'; role: 'member' | 'exco'; groupName: string }>('registerMember'),
  registerPlatformAdmin: callable<
    ProfileInput & { group: { name: string; lga: string; state: string } },
    { ok: true; status: 'approved'; role: 'exco'; groupName: string; joinCode: string }
  >('registerPlatformAdmin'),
  createManagedGroup: callable<
    { group: { name: string; lga: string; state: string }; mainExcoStateCode: string },
    { ok: true; groupId: string; joinCode: string; mainExcoStateCode: string }
  >('createManagedGroup'),
  approveMember: callable<Who & { approve: boolean }, { ok: true }>('approveMember'),
  setRole: callable<Who & { role: 'member' | 'exco' }, { ok: true }>('setRole'),
  resetPin: callable<Who & { pin: string }, { ok: true }>('resetPin'),
  updateGroupSettings: callable<
    { batchSize?: number; venue?: { lat: number; lng: number; radiusM?: number }; clearVenue?: boolean },
    { ok: true }
  >('updateGroupSettings'),

  // CDS day
  startSession: callable<Record<string, never>, { ok: true; sessionId: string }>('startSession'),
  endSession: callable<Record<string, never>, { ok: true }>('endSession'),
  getDoorCode: callable<Record<string, never>, { code: string; gid: string; sessionId: string; epoch?: number; expiresAt: number }>('getDoorCode'),
  checkIn: callable<
    { code: string; gid?: string; lat?: number; lng?: number; scannedAt?: number },
    { number: number; already: boolean; sessionId: string }
  >('checkIn'),
  lookupMember: callable<Who, { member: PublicMember; attendee: Attendee | null }>('lookupMember'),
  excoCheckIn: callable<Who & { method: 'card' | 'manual' }, { number: number; already: boolean; member: PublicMember }>('excoCheckIn'),
  setPriority: callable<Who, { ok: true; pNumber: number }>('setPriority'),
  callNext: callable<{ mode: 'priority' | 'next' }, { ok: true; batch: Batch; notified: number; inBatch: number }>('callNext'),
  giveNextNumber: callable<Who, { number: number; already: boolean; member: PublicMember }>('giveNextNumber'),
  sendGroupMessage: callable<
    { title: string; body: string; audience: 'all' | 'unpaid' | 'pending' | 'excos'; link: string },
    { ok: true; recipients: number; delivered: number; left: number }
  >('sendGroupMessage'),
  listGroupMessages: callable<
    Record<string, never>,
    {
      left: number;
      messages: { id: string; title: string; body: string; audience: string; recipients: number; delivered: number; sentByName: string; sentAt: number | null }[];
    }
  >('listGroupMessages'),
  // ---- platform / admin mode
  appStatus: callable<Record<string, never>, { banner: string | null; maintenance: string | null; signupsPaused: boolean; paymentsPaused: boolean }>('appStatus'),
  adminWhoAmI: callable<Record<string, never>, { role: PlatformRole | null }>('adminWhoAmI'),
  adminOverview: callable<{ refresh?: boolean }, AdminOverview>('adminOverview'),
  adminGetConfig: callable<Record<string, never>, AdminConfig>('adminGetConfig'),
  adminSetConfig: callable<Partial<{ signupsPaused: boolean; paymentsPaused: boolean; maintenance: string | null; banner: string | null }>, { ok: true }>('adminSetConfig'),
  adminSetGroupPaused: callable<{ gid: string; paused: boolean }, { ok: true }>('adminSetGroupPaused'),
  adminBroadcast: callable<
    { title: string; body: string; audience: 'everyone' | 'excos'; gids: string[]; link: string },
    { ok: true; recipients: number; delivered: number }
  >('adminBroadcast'),
  adminSetTeamMember: callable<{ stateCode: string; role: 'admin' | 'viewer' | null }, { ok: true }>('adminSetTeamMember'),
  testNotification: callable<Record<string, never>, { sent: number; registered: number; members: number }>('testNotification'),
  tableCheck: callable<Who, TableCheckResponse>('tableCheck'),
  markDone: callable<Who, { ok: true }>('markDone'),

  // dues
  listBanks: callable<Record<string, never>, { name: string; code: string }[]>('listBanks'),
  resolveAccount: callable<{ bankCode: string; accountNumber: string }, { accountName: string }>('resolveAccount'),
  setPayoutAccount: callable<{ bankCode: string; bankName: string; accountNumber: string }, { ok: true; accountName: string }>('setPayoutAccount'),
  createDues: callable<{ title: string; amountNaira: number; dueDate?: string; requiredForCheckIn?: boolean }, { ok: true; duesId: string }>('createDues'),
  closeDues: callable<{ duesId: string }, { ok: true }>('closeDues'),
  startPayment: callable<{ duesId: string; returnUrl: string }, { authorizationUrl: string; reference: string; totalKobo: number }>('startPayment'),
  verifyPayment: callable<{ reference: string }, { status: string }>('verifyPayment'),
  recordCash: callable<Who & { duesId: string }, { ok: true }>('recordCash'),
  respondCash: callable<{ duesId: string; confirm: boolean }, { ok: true }>('respondCash'),
  remindDues: callable<{ duesId: string }, { ok: true; owing: number; notified: number }>('remindDues'),
};

export type PlatformRole = 'owner' | 'admin' | 'viewer';

export interface AdminGroupRow {
  id: string;
  name: string;
  lga: string;
  state: string;
  joinCode: string;
  paused: boolean;
  mainExcoStateCode: string | null;
  members: number;
  pending: number;
  excos: number;
  noPhoto: number;
  lastMeeting: string | null;
  lastCheckins: number;
  onlineKobo: number;
  cashKobo: number;
  earnedKobo: number;
  createdAt: number | null;
}

export interface AdminOverview {
  generatedAt: number;
  totals: { groups: number; activeGroups: number; members: number; pending: number; onlineKobo: number; cashKobo: number; earnedKobo: number; checkins30: number };
  series: { days: string[]; signups: number[]; checkins: number[]; paidKobo: number[]; earnedKobo: number[] };
  groups: AdminGroupRow[];
}

export interface AdminConfig {
  role: PlatformRole;
  signupsPaused: boolean;
  paymentsPaused: boolean;
  maintenance: string | null;
  banner: string | null;
  team: { stateCode: string; role: 'admin' | 'viewer' }[];
  owner: string | null;
}
```

---

### `web/src/lib/appConfig.ts`

```ts
/** Public browser configuration for CDS Pass. These values are bundled into the frontend. */
const liveFirebaseConfig = {"apiKey":"AIzaSyAsuZMiSs6Qgu2p6fpQCzPXrYR_a1q9K8E","authDomain":"cds-pass.firebaseapp.com","projectId":"cds-pass","storageBucket":"cds-pass.firebasestorage.app","messagingSenderId":"214017403181","appId":"1:214017403181:web:92cf6330c143c58b10cba4"};
// Used to show the group-creation option. The server separately verifies the signed-in account.
export const PLATFORM_ADMIN_STATE_CODE = 'LA/26B/2578';
const LIVE_API_URL = 'https://cds-pass.onrender.com';
export const VAPID_KEY = 'BAkiu3AGhJLUKS4KCKSO7sbohw_VPIBV4zN80yJjiyEHiESvtsQuldI_BAzyefepYlAo_-OACNwMkmGu_auIAl4';
export const SERVICE_FEE_PERCENT = 3;
export const PAYSTACK_FEE_PERCENT = 1.5;

/**
 * Safe local testing. Only when you run `npm run dev` AND web/.env has VITE_USE_EMULATORS=true,
 * the site talks to the Firebase emulators and the server on your PC (no real data, no real money).
 * A production build (`npm run build`) ALWAYS uses the live values above.
 */
export const USE_EMULATORS = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === 'true';

export const firebaseConfig = USE_EMULATORS
  ? { ...liveFirebaseConfig, apiKey: 'demo-key', projectId: 'demo-cds-pass', authDomain: 'demo-cds-pass.firebaseapp.com' }
  : liveFirebaseConfig;

export const API_URL = USE_EMULATORS ? 'http://localhost:8787' : LIVE_API_URL;
```

---

### `web/src/lib/device.ts`

```ts
/** Full 3D only on phones that can handle it, and never for people who prefer less motion. */
export function canUse3D(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  if (saveData) return false;
  try {
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl2') || c.getContext('webgl'))) return false;
  } catch {
    return false;
  }
  return cores >= 4 && mem >= 2;
}

export function getPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
```

---

### `web/src/lib/firebase.ts`

```ts
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

import { API_URL, USE_EMULATORS, firebaseConfig } from './appConfig';

export { firebaseConfig, API_URL } from './appConfig';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Offline cache: your tag and status still show when there is no data.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

if (USE_EMULATORS) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
  console.info('CDS Pass: using local emulators and http://localhost:8787 (test mode).');
}

/** Render's free server sleeps; poke it as soon as someone opens sign-up or login so it's awake in time. */
let woken = false;
export function wakeServer() {
  if (woken) return;
  woken = true;
  void fetch(`${API_URL}/health`, { cache: 'no-store' }).catch(() => undefined);
}

let wakeNoticeShown = false;

/**
 * Calls an action on the API server with the member's login token.
 * Errors come back with a `functions/<status>` code so errorText() keeps working.
 */
export function callable<Req = unknown, Res = unknown>(name: string) {
  return async (data: Req): Promise<Res> => {
    const token = await auth.currentUser?.getIdToken();
    // Render's free server sleeps when idle; the first request can take ~50 s to wake it.
    const slow = setTimeout(() => {
      if (wakeNoticeShown) return;
      wakeNoticeShown = true;
      void import('./toast').then(({ toast }) => toast('Server is waking up…', 'info', 'This can take up to a minute the first time. Please wait.'));
    }, 6000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ data }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw Object.assign(new Error('The server took too long to respond. Your account may already have been created. Please try signing in, or continue signup to finish your profile.'), {
          code: 'functions/deadline-exceeded',
        });
      }
      throw Object.assign(new Error('No internet connection.'), { code: 'functions/unavailable' });
    } finally {
      clearTimeout(slow);
      clearTimeout(timeout);
    }
    const json = (await res.json().catch(() => ({}))) as { result?: Res; error?: { status?: string; message?: string } };
    if (!res.ok) {
      throw Object.assign(new Error(json.error?.message ?? 'Something went wrong. Please try again.'), {
        code: `functions/${json.error?.status ?? 'internal'}`,
      });
    }
    return json.result as Res;
  };
}

/** Turns Firebase errors into a sentence a corps member can understand. */
export function errorText(e: unknown): string {
  const err = e as { code?: string; message?: string };
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong state code or PIN.';
    case 'auth/email-already-in-use':
      return 'This state code already has an account. Tap Log in, use the same PIN, and you will continue where you stopped.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
    case 'functions/unavailable':
      return 'No internet connection. Check your data and try again.';
    case 'functions/deadline-exceeded':
      return err.message ?? 'The server did not respond. Please try again in a moment.';
  }
  const msg = err?.message ?? 'Something went wrong.';
  return msg.replace(/^Firebase:\s*/, '').replace(/\s*\(.*\)\.?$/, '');
}
```

---

### `web/src/lib/image.ts`

```ts
/**
 * Crops a photo to a centred square and shrinks it to ~512px JPEG,
 * so a profile picture costs ~40–80 KB of data instead of several MB.
 *
 * Phone cameras take 12–50 megapixel photos. Opening one at full size needs 50–200 MB of memory,
 * which can make a low-memory phone close the app. So we ask the browser to decode it already
 * shrunk (createImageBitmap with resize), and only fall back to the full-size way if that isn't supported.
 */
export async function compressPhoto(file: File, size = 512, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/') && file.type !== '') throw new Error('Please choose a photo.');

  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let cleanup = () => {};

  try {
    // Decode at about 2× the final size; keeps the shape, uses a fraction of the memory.
    const bmp = await createImageBitmap(file, { resizeWidth: size * 2, resizeQuality: 'high', imageOrientation: 'from-image' });
    source = bmp;
    width = bmp.width;
    height = bmp.height;
    cleanup = () => bmp.close();
  } catch {
    const url = URL.createObjectURL(file);
    cleanup = () => URL.revokeObjectURL(url);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that photo. Try another one.'));
      i.src = url;
    }).catch((e) => {
      cleanup();
      throw e;
    });
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }

  try {
    const side = Math.min(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot process photos.');
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process photo.'))), 'image/jpeg', quality),
    );
  } finally {
    cleanup();
  }
}
```

---

### `web/src/lib/install.ts`

```ts
import { useSyncExternalStore } from 'react';

/** Chrome / Edge / Samsung Internet fire this when the site can be installed. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

/** Call once, as early as possible, so the browser's install offer isn't missed. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', emit);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export type Platform = 'ios' | 'android' | 'inapp' | 'desktop';

export function platform(): Platform {
  const ua = navigator.userAgent;
  // WhatsApp, Instagram, Facebook, X etc. open links in their own browser, which can't install apps.
  if (/FBAN|FBAV|Instagram|WhatsApp|Twitter|Line\/|MicroMessenger|; wv\)/i.test(ua)) return 'inapp';
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || iPadOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Phones must use the installed app. Laptops can use the website as-is.
 * Not enforced while developing (npm run dev) or on plain http, where installing is impossible.
 */
export function mustInstall(): boolean {
  if (import.meta.env.DEV) return false;
  if (!window.isSecureContext) return false;
  return platform() !== 'desktop' && !isStandalone();
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  emit();
  return outcome === 'accepted';
}

export function useInstallState() {
  const snap = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => `${!!deferred}|${installed}|${isStandalone()}`,
  );
  const [canPrompt, justInstalled, standalone] = snap.split('|').map((x) => x === 'true');
  return { canPrompt, justInstalled, standalone };
}
```

---

### `web/src/lib/messaging.ts`

```ts
import { arrayUnion, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { app, db } from './firebase';
import { VAPID_KEY } from './appConfig';
import { registerServiceWorker } from './sw';
import { batchTurnToast, toast } from './toast';

export type PushState = 'unsupported' | 'default' | 'granted' | 'enabled' | 'denied';

export async function pushState(uid?: string): Promise<PushState> {
  if (!('Notification' in window) || !(await isSupported())) return 'unsupported';
  if (Notification.permission === 'granted' && uid && localStorage.getItem(`cdspass:push:${uid}`) === 'on') return 'enabled';
  return Notification.permission as PushState;
}

/** Asks permission, gets an FCM token and saves it on the member's profile. */
export async function enableNotifications(uid: string): Promise<void> {
  if (!VAPID_KEY.trim()) {
    throw new Error('Push alerts are not configured yet. The site owner must add the Firebase Web Push key before alerts can work.');
  }
  if (!(await isSupported())) {
    throw new Error(
      /iPhone|iPad/.test(navigator.userAgent)
        ? 'On iPhone, first tap Share → "Add to Home Screen", then open CDS Pass from there.'
        : 'This browser does not support notifications. Try Chrome.',
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.');

  const reg = await registerServiceWorker();
  if (!reg) throw new Error('Could not set up notifications on this browser.');
  const token = await getToken(getMessaging(app), {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: reg,
  });
  if (!token) throw new Error('Could not set up notifications. Try again.');
  await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token), updatedAt: serverTimestamp() });
  localStorage.setItem(`cdspass:push:${uid}`, 'on');
}

/** When the site is open, show incoming pushes as an in-app toast instead. */
export async function listenForegroundPush() {
  if (!(await isSupported())) return;
  onMessage(getMessaging(app), (payload) => {
    const d = payload.data ?? {};
    navigator.vibrate?.([300, 120, 300]);
    if (d.kind === 'batch-call') batchTurnToast(d.title ?? "It's your turn!", d.body);
    else toast(d.title ?? 'CDS Pass', 'success', d.body);
  });
}
```

---

### `web/src/lib/money.ts`

```ts
import { PAYSTACK_FEE_PERCENT, SERVICE_FEE_PERCENT } from './appConfig';

export const naira = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Same maths as duesCharges on the server: dues + 3% service + Paystack's exact charge, rounded up to the naira. */
export function duesCharges(amountKobo: number) {
  const servicePercent = SERVICE_FEE_PERCENT;
  const paystackPercent = PAYSTACK_FEE_PERCENT;
  const up = (k: number) => Math.ceil(k / 100) * 100;
  const serviceKobo = up((amountKobo * servicePercent) / 100);
  // Paystack charges 1.5% of the TOTAL, plus ₦100 when the total is ₦2,500 or more, capped at ₦2,000.
  // Work out the part that exactly covers that, so the group gets the full dues and you keep the full 3%.
  const base = amountKobo + serviceKobo;
  const rate = paystackPercent / 100;
  let paystackKobo = up((base * rate) / (1 - rate));
  if (base + paystackKobo >= 250_000) paystackKobo = up((base * rate + 10_000) / (1 - rate));
  paystackKobo = Math.min(paystackKobo, 200_000);
  return { serviceKobo, paystackKobo, chargesKobo: serviceKobo + paystackKobo, totalKobo: base + paystackKobo };
}
```

---

### `web/src/lib/offlineQueue.ts`

```ts
import { api } from './api';
import { errorText } from './firebase';
import { toast } from './toast';

/**
 * When a member scans the door code with no data, we save the scan here
 * and send it as soon as the phone is back online. The server checks the
 * code against the time it was scanned, so it cannot be faked later.
 */
const KEY = 'cdspass:pendingCheckin';

export interface PendingCheckin {
  code: string;
  gid?: string;
  scannedAt: number;
  lat?: number;
  lng?: number;
}

export function savePending(p: PendingCheckin) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — ignore */
  }
}

export function getPending(): PendingCheckin | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingCheckin) : null;
  } catch {
    return null;
  }
}

function clearPending() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

let flushing = false;

export async function flushPending(): Promise<void> {
  const p = getPending();
  if (!p || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const r = await api.checkIn(p);
    clearPending();
    toast(`Checked in · No. ${r.number}`, 'success', 'Your saved scan has been sent.');
  } catch (e) {
    const msg = errorText(e);
    if (!/internet/i.test(msg)) {
      clearPending();
      toast('Saved check-in failed', 'error', msg);
    }
  } finally {
    flushing = false;
  }
}

export function startOfflineSync() {
  window.addEventListener('online', () => void flushPending());
  void flushPending();
}
```

---

### `web/src/lib/rules.ts`

```ts
// Mirrors functions/src/shared.ts — the server is the real judge; this only drives the UI.
import type { Attendee, Batch } from './types';

export const STATE_CODE_RE = /^[A-Z]{2}\/\d{2}[A-C]\/\d{4,5}$/;

export function normalizeStateCode(input: string): string | null {
  let s = input.toUpperCase().trim().replace(/[-\\]/g, '/').replace(/\s*\/\s*/g, '/');
  if (!s.includes('/')) {
    const m = s.replace(/\s+/g, '').match(/^([A-Z]{2})(\d{2}[A-C])(\d{4,5})$/);
    if (m) s = `${m[1]}/${m[2]}/${m[3]}`;
  }
  s = s.replace(/\s+/g, '');
  return STATE_CODE_RE.test(s) ? s : null;
}

export function stateCodeToEmail(stateCode: string): string {
  return `${stateCode.replace(/\//g, '').toLowerCase()}@cdspass.app`;
}

export function normalizePhone(input: string): string | null {
  const d = input.replace(/[\s()-]/g, '');
  const m = d.match(/^(?:\+?234|0)([789]\d{9})$/);
  return m ? `+234${m[1]}` : null;
}

export function lagosDate(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function isTurn(att: Pick<Attendee, 'number' | 'priority' | 'status'>, batch: Batch | null | undefined) {
  if (!batch || att.status !== 'waiting') return false;
  if (att.priority) return true;
  return batch.kind === 'regular' && att.number <= batch.to;
}

export function batchLabel(batch: Batch | null | undefined): string {
  if (!batch) return 'Not started';
  return batch.kind === 'priority' ? 'Priority' : `${batch.from} – ${batch.to}`;
}

export function tagLabel(att: Pick<Attendee, 'number' | 'priority' | 'pNumber'>): string {
  return att.priority && att.pNumber ? `P${att.pNumber}` : String(att.number);
}

/** How many people are ahead of me (rough, for the "about X mins" line). */
export function aheadOf(att: Pick<Attendee, 'number' | 'priority'>, batch: Batch | null | undefined) {
  if (att.priority) return 0;
  const doneUpTo = batch?.kind === 'regular' ? batch.to : 0;
  return Math.max(0, att.number - doneUpTo - 1);
}

// QR payloads
export const doorQR = (gid: string, code: string) => `CDSPASS:D:${gid}:${code}`;
export const memberQR = (uid: string) => `CDSPASS:M:${uid}`;

export function parseQR(text: string):
  | { type: 'door'; gid: string; code: string }
  | { type: 'member'; uid: string }
  | null {
  const parts = text.trim().split(':');
  if (parts[0] !== 'CDSPASS') return null;
  if (parts[1] === 'D' && parts.length === 4) return { type: 'door', gid: parts[2], code: parts[3] };
  if (parts[1] === 'M' && parts.length === 3) return { type: 'member', uid: parts[2] };
  return null;
}
```

---

### `web/src/lib/signupDraft.ts`

```ts
/**
 * Keeps what someone has typed during sign-up, so it survives the phone closing the app.
 *
 * Why: on many Android phones, opening the camera or gallery uses so much memory that the
 * system kills the browser / installed app in the background. When the person comes back the
 * app starts fresh and everything typed was gone, so they were stuck in a loop at the photo step.
 *
 * Stored on this phone only (localStorage), for at most 24 hours, and never the PIN.
 * Cleared when sign-up succeeds or the person logs out.
 */
const KEY = 'cdspass.signupDraft.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SignupDraft {
  step: number;
  stateCode: string;
  fullName: string;
  phone: string;
  joinCode: string;
  startGroup: boolean;
  group: { name: string; lga: string; state: string };
  /** The already-shrunk photo (~50 KB) as a data URL. */
  photo: string | null;
  /** True while the camera/gallery is open; if we start up with this still set, the phone closed the app. */
  pickerOpen: boolean;
  savedAt: number;
}

export function loadDraft(): SignupDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SignupDraft;
    if (!d || typeof d.savedAt !== 'number' || Date.now() - d.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function saveDraft(d: Omit<SignupDraft, 'savedAt'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch {
    // Storage full or blocked (private mode): try again without the photo, else give up quietly.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...d, photo: null, savedAt: Date.now() }));
    } catch {
      /* nothing else we can do */
    }
  }
}

/** Marks the camera/gallery as open (or closed) without touching the rest of the draft. */
export function markPickerOpen(open: boolean) {
  const d = loadDraft();
  if (d) saveDraft({ ...d, pickerOpen: open });
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}
```

---

### `web/src/lib/signupLock.ts`

```ts
import { useSyncExternalStore } from 'react';

/**
 * While sign-up is running, the account exists before the profile does.
 * This lock keeps the sign-up screen on screen until everything is saved.
 */
export type SignupLock = false | 'signup' | 'finish';
let locked: SignupLock = false;
const subs = new Set<() => void>();

export function setSignupLock(v: SignupLock) {
  locked = v;
  subs.forEach((s) => s());
}

export function useSignupLock(): SignupLock {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => locked,
  );
}
```

---

### `web/src/lib/sw.ts`

```ts
import { firebaseConfig } from './firebase';

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the one service worker that handles offline cache + notifications. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  if (!('serviceWorker' in navigator)) return (registration = Promise.resolve(null));
  const qs = new URLSearchParams({
    apiKey: firebaseConfig.apiKey ?? '',
    projectId: firebaseConfig.projectId ?? '',
    messagingSenderId: firebaseConfig.messagingSenderId ?? '',
    appId: firebaseConfig.appId ?? '',
  });
  registration = navigator.serviceWorker
    .register(`/firebase-messaging-sw.js?${qs}`, { scope: '/' })
    .catch((e) => {
      console.warn('Service worker failed', e);
      return null;
    });
  return registration;
}
```

---

### `web/src/lib/tagImage.ts`

```ts
/**
 * Draws the member's tag as a PNG (1080 × 1350, WhatsApp/Instagram friendly)
 * and shares it, or downloads it where sharing files isn't supported.
 */
export interface TagImageInput {
  name: string;
  stateCode: string;
  groupName?: string;
  tag: string | null;
  status: 'none' | 'waiting' | 'turn' | 'done';
  photoURL: string | null;
  /** A <canvas> that already has the member's QR code drawn on it. */
  qrCanvas: HTMLCanvasElement | null;
}

const W = 1080;
const H = 1350;
const FONT = '"Plus Jakarta Sans", system-ui, sans-serif';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export async function drawTag(input: TagImageInput): Promise<Blob> {
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  // Background
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0E7F46');
  bg.addColorStop(0.55, '#0B6B3A');
  bg.addColorStop(1, '#03301A');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  for (let x = 18; x < W; x += 36) for (let y = 18; y < H; y += 36) g.fillRect(x, y, 3, 3);

  // Header
  g.fillStyle = '#FFFFFF';
  g.font = `800 44px ${FONT}`;
  g.textAlign = 'left';
  g.fillText('CDS PASS', 80, 120);
  if (input.groupName) {
    g.font = `700 30px ${FONT}`;
    const w = g.measureText(input.groupName).width + 48;
    g.fillStyle = 'rgba(255,255,255,0.16)';
    roundRect(g, W - 80 - w, 78, w, 60, 30);
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.textAlign = 'center';
    g.fillText(input.groupName, W - 80 - w / 2, 119);
  }

  // Photo + name
  const cx = 170;
  const cy = 270;
  const rad = 88;
  g.save();
  g.beginPath();
  g.arc(cx, cy, rad + 10, 0, Math.PI * 2);
  g.fillStyle = '#FFFFFF';
  g.fill();
  g.beginPath();
  g.arc(cx, cy, rad, 0, Math.PI * 2);
  g.clip();
  const photo = input.photoURL ? await loadImage(input.photoURL) : null;
  if (photo) {
    g.drawImage(photo, cx - rad, cy - rad, rad * 2, rad * 2);
  } else {
    g.fillStyle = '#E3F2E8';
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    g.fillStyle = '#0B6B3A';
    g.font = `800 64px ${FONT}`;
    g.textAlign = 'center';
    const initials = input.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    g.fillText(initials, cx, cy + 22);
  }
  g.restore();

  g.textAlign = 'left';
  g.fillStyle = '#FFFFFF';
  g.font = `800 52px ${FONT}`;
  let name = input.name;
  while (g.measureText(name).width > W - 380 && name.length > 4) name = name.slice(0, -2);
  if (name !== input.name) name = name.trimEnd() + '…';
  g.fillText(name, 300, 260);
  g.fillStyle = '#CFE6D6';
  g.font = `700 36px ${FONT}`;
  g.fillText(input.stateCode, 300, 315);

  // Big number
  g.textAlign = 'center';
  g.fillStyle = '#CFE6D6';
  g.font = `700 30px ${FONT}`;
  g.fillText('Y O U R   N U M B E R', W / 2, 470);
  g.font = `800 250px ${FONT}`;
  g.fillStyle = '#053D20';
  g.fillText(input.tag ?? '—', W / 2 + 6, 700 + 10);
  g.fillStyle = '#FFFFFF';
  g.fillText(input.tag ?? '—', W / 2, 700);

  // Status pill
  const statusText = {
    none: 'Not checked in today',
    waiting: 'Waiting for my batch',
    turn: "It's my turn ✓",
    done: 'Thumbprinted ✓',
  }[input.status];
  g.font = `800 34px ${FONT}`;
  const sw = g.measureText(statusText).width + 80;
  g.fillStyle = input.status === 'waiting' ? '#C9B783' : '#FFFFFF';
  roundRect(g, (W - sw) / 2, 750, sw, 76, 38);
  g.fill();
  g.fillStyle = input.status === 'waiting' ? '#03301A' : '#0B6B3A';
  g.fillText(statusText, W / 2, 800);

  // QR on white
  const qs = 300;
  const qx = (W - qs - 60) / 2;
  const qy = 880;
  g.fillStyle = '#FFFFFF';
  roundRect(g, qx, qy, qs + 60, qs + 60, 36);
  g.fill();
  if (input.qrCanvas) {
    g.imageSmoothingEnabled = false;
    g.drawImage(input.qrCanvas, qx + 30, qy + 30, qs, qs);
  }

  // Footer
  const date = new Date().toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
  g.fillStyle = '#CFE6D6';
  g.font = `600 28px ${FONT}`;
  g.fillText(`${date} · Show this with your NYSC ID card`, W / 2, H - 60);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png'));
}

/** Opens the phone's share sheet (WhatsApp, etc). Falls back to downloading the PNG. */
export async function shareTag(input: TagImageInput): Promise<'shared' | 'saved'> {
  const blob = await drawTag(input);
  const file = new File([blob], `cds-pass-${(input.tag ?? 'tag').toLowerCase()}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'My CDS Pass tag', text: input.tag ? `My CDS number today: ${input.tag}` : 'My CDS Pass tag' });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  saveBlob(blob, file.name);
  return 'saved';
}

export async function saveTag(input: TagImageInput) {
  const blob = await drawTag(input);
  saveBlob(blob, `cds-pass-${(input.tag ?? 'tag').toLowerCase()}.png`);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
```

---

### `web/src/lib/theme.ts`

```ts
import { useSyncExternalStore } from 'react';

/** System = follow the phone/laptop setting. */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'cdspass:theme';
const subs = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && !!media?.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#03301A' : '#0B6B3A');
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  apply(mode);
  subs.forEach((s) => s());
}

export function initTheme() {
  apply(getThemeMode());
  // When the phone switches to dark mode (e.g. at night), follow it.
  media?.addEventListener('change', () => {
    if (getThemeMode() === 'system') apply('system');
  });
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    getThemeMode,
  );
}
```

---

### `web/src/lib/toast.ts`

```ts
export type ToastKind = 'info' | 'success' | 'error';
export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  kind: ToastKind;
}

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();
let nextId = 1;
let lastBatchTurnToastAt = 0;

function emit() {
  listeners.forEach((l) => l(items));
}

export function toast(title: string, kind: ToastKind = 'info', body?: string) {
  const id = nextId++;
  items = [...items, { id, title, body, kind }].slice(-3);
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 4000);
}

/** Firestore turn updates and foreground FCM can report the same batch call. */
export function batchTurnToast(title: string, body?: string) {
  const now = Date.now();
  if (now - lastBatchTurnToastAt < 5000) return;
  lastBatchTurnToastAt = now;
  toast(title, 'success', body);
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(l: Listener) {
  listeners.add(l);
  l(items);
  return () => {
    listeners.delete(l);
  };
}
```

---

### `web/src/lib/types.ts`

```ts
import type { Timestamp } from 'firebase/firestore';

export type Role = 'member' | 'exco';
export type MemberStatus = 'pending' | 'approved' | 'rejected';

export interface Profile {
  uid: string;
  stateCode: string;
  fullName: string;
  phone: string;
  photoURL: string | null;
  groupId: string;
  role: Role;
  status: MemberStatus;
  fcmTokens?: string[];
  createdAt?: Timestamp;
}

export interface Group {
  id: string;
  createdBy: string;
  mainExcoUid?: string | null;
  mainExcoStateCode?: string | null;
  name: string;
  lga: string;
  state: string;
  joinCode: string;
  batchSize: number;
  venue: { lat: number; lng: number; radiusM: number } | null;
  payout?: { bankName: string; accountName: string; last4: string } | null;
}

export interface Dues {
  id: string;
  title: string;
  amountKobo: number;
  /** Collection date (YYYY-MM-DD). */
  dueDate: string | null;
  /** Members must pay before they can get a number, from the collection date. */
  requiredForCheckIn?: boolean;
  active: boolean;
  createdAt?: Timestamp;
}

/** groups/{gid}/dues/{duesId}/status/{uid} */
export interface DuesStatus {
  uid: string;
  status: 'paid' | 'cash_pending' | 'disputed';
  method: 'online' | 'cash';
  amountKobo: number;
  reference: string;
  fullName: string;
  stateCode: string;
  recordedByName?: string;
  paidAt?: Timestamp;
  recordedAt?: Timestamp;
}

export interface Payment {
  id: string;
  reference: string;
  uid: string;
  duesId: string;
  duesTitle: string;
  amountKobo: number;
  feeKobo: number;
  paystackKobo?: number;
  totalKobo: number;
  method: 'online' | 'cash';
  status: 'pending' | 'paid' | 'awaiting_member' | 'disputed';
  recordedByName?: string;
  createdAt?: Timestamp;
  paidAt?: Timestamp;
}

export type Batch =
  | { kind: 'priority'; seq: number; calledAt?: Timestamp }
  | { kind: 'regular'; seq: number; from: number; to: number; calledAt?: Timestamp };

export interface Session {
  id: string;
  status: 'open' | 'closed';
  nextNumber?: number;
  nextPriority?: number;
  lastTo: number;
  batchSeq: number;
  batch: Batch | null;
  /** Goes up when the main exco gives a number by hand; the door screen fetches a new code. */
  doorEpoch?: number;
}

export interface Attendee {
  uid: string;
  number: number;
  priority: boolean;
  pNumber: number | null;
  status: 'waiting' | 'done';
  method: 'self' | 'offline' | 'card' | 'manual';
  checkedInAt?: Timestamp;
  doneAt?: Timestamp;
  fullName: string;
  stateCode: string;
  photoURL: string | null;
}

export interface PublicMember {
  uid: string;
  fullName: string;
  stateCode: string;
  photoURL: string | null;
  status: MemberStatus;
  role: Role;
}

export type TableResult = 'your_turn' | 'not_turn' | 'already_done' | 'not_checked_in' | 'not_started';

export interface TableCheckResponse {
  result: TableResult;
  member: PublicMember;
  batch: Batch | null;
  number?: number;
  priority?: boolean;
  pNumber?: number | null;
  doneAt?: number | null;
}

export interface LogEntry {
  id: string;
  at?: Timestamp;
  atMs?: number | null;
  by: string;
  action: string;
  target?: string;
  stateCode?: string;
  [k: string]: unknown;
}
```

---

### `web/src/lib/upload.ts`

```ts
import { API_URL, auth } from './firebase';

/**
 * Uploads a compressed profile picture to Cloudinary (through our API server)
 * and returns its public URL. Only this URL is saved in the database.
 *
 * Signature is unchanged (uid, blob), so Signup.tsx and Profile.tsx need no edits.
 * The server uses the login token to know who the photo belongs to.
 */
export async function uploadAvatar(_uid: string, blob: Blob): Promise<string> {
  // Slow networks: give each try 40 s, and try a second time automatically before giving up.
  try {
    return await uploadOnce(blob, 40_000);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'functions/deadline-exceeded' && code !== 'functions/unavailable' && code !== 'functions/internal') throw e;
    return await uploadOnce(blob, 40_000);
  }
}

async function uploadOnce(blob: Blob, timeoutMs: number): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Please log in again.');

  const form = new FormData();
  form.append('file', blob, 'avatar.jpg');

  let res: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    res = await fetch(`${API_URL}/upload/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // no Content-Type: the browser sets it for FormData
      body: form,
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('Photo upload took too long. Check your connection and try again.'), { code: 'functions/deadline-exceeded' });
    }
    throw Object.assign(new Error('No internet connection.'), { code: 'functions/unavailable' });
  } finally {
    clearTimeout(timeout);
  }

  const json = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!res.ok || !json.url) {
    throw Object.assign(new Error(json.error?.message ?? 'Could not upload your photo. Please try again.'), {
      code: res.status >= 500 ? 'functions/internal' : 'functions/invalid-argument',
    });
  }
  return json.url;
}
```

---

### `web/src/main.tsx`

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './hooks/useAuth';
import { listenForegroundPush } from './lib/messaging';
import { registerServiceWorker } from './lib/sw';
import { initTheme } from './lib/theme';
import { captureInstallPrompt } from './lib/install';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

initTheme();
captureInstallPrompt();
void registerServiceWorker();
void listenForegroundPush();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
```

---

### `web/src/pages/Login.tsx`

```tsx
import { signInWithEmailAndPassword } from 'firebase/auth';
import { motion } from 'framer-motion';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorBox, Field, TopBar } from '../components/ui';
import { auth, errorText, wakeServer } from '../lib/firebase';
import { normalizeStateCode, stateCodeToEmail } from '../lib/rules';

export default function Login() {
  const [stateCode, setStateCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Wake the free Render server early so the first screen after login loads quickly.
  useEffect(() => wakeServer(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const sc = normalizeStateCode(stateCode);
    if (!sc) return setError('Enter your state code like LA/26B/1142.');
    if (!/^\d{6}$/.test(pin)) return setError('Your PIN is 6 digits.');
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, stateCodeToEmail(sc), pin);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <TopBar title="Log in" back="/" />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-1 flex-col gap-5 px-5 pb-8 pt-6"
      >
        <div>
          <h2 className="text-2xl font-extrabold">Welcome back</h2>
          <p className="text-muted">Use your NYSC state code and your 6-digit PIN.</p>
        </div>
        <Field
          label="State code"
          placeholder="LA/26B/1142"
          autoCapitalize="characters"
          autoComplete="username"
          value={stateCode}
          onChange={(e) => setStateCode(e.target.value)}
        />
        <Field
          label="PIN"
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={6}
          autoComplete="current-password"
          placeholder="••••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <ErrorBox>{error}</ErrorBox>
        <div className="mt-auto space-y-3">
          <Button type="submit" loading={busy}>
            Log in
          </Button>
          <p className="text-center text-sm text-muted">
            Forgot your PIN? Ask your CDS exco to reset it after checking your ID card.
          </p>
          <p className="text-center text-sm">
            New here?{' '}
            <Link to="/signup" className="font-bold text-green">
              Create an account
            </Link>
          </p>
        </div>
      </motion.form>
    </div>
  );
}
```

---

### `web/src/pages/Pending.tsx`

```tsx
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { Avatar } from '../components/Avatar';
import { PhotoPicker } from '../components/PhotoPicker';
import { Button, ErrorBox } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { db, errorText } from '../lib/firebase';
import { toast } from '../lib/toast';
import { uploadAvatar } from '../lib/upload';

/** Shown when the photo didn't upload during sign-up (slow network). The exco needs it to approve. */
function AddPhoto({ uid }: { uid: string }) {
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!photo) return setError('Take or choose a clear photo of your face first.');
    setBusy(true);
    setError('');
    try {
      const photoURL = await uploadAvatar(uid, photo);
      await updateDoc(doc(db, 'users', uid), { photoURL, updatedAt: serverTimestamp() });
      toast('Photo saved', 'success', 'The exco can now review your account.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 w-full space-y-4 rounded-3xl bg-card p-6 text-left text-ink shadow-lift">
      <div>
        <p className="text-lg font-extrabold">Add your photo</p>
        <p className="text-sm text-muted">Your photo didn't upload during sign-up. The exco needs it to approve you.</p>
      </div>
      <PhotoPicker
        value={photo}
        onChange={(b, err) => {
          setPhoto(b);
          setError(err ?? '');
        }}
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      <Button onClick={save} disabled={busy || !photo}>
        {busy ? 'Uploading…' : 'Save photo'}
      </Button>
    </div>
  );
}

const steps = [
  { t: 'Account created', d: 'Your details and photo are saved.' },
  { t: 'Exco review', d: 'An exco checks your name, state code and photo.' },
  { t: 'Approved', d: 'You can scan in and get your number at CDS.' },
];

/** Shown until an exco approves the member from the Members screen. Updates by itself. */
export default function Pending() {
  const { profile, logout } = useAuth();
  if (!profile) return null;
  const rejected = profile.status === 'rejected';

  return (
    <div className="screen hero-green text-white">
      <div className="flex flex-1 flex-col items-center px-6 pb-8 pt-[max(2.5rem,env(safe-area-inset-top))] text-center">
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="relative">
          {!rejected && (
            <motion.span
              className="absolute -inset-3 rounded-full border-4 border-khaki/70"
              animate={{ scale: [1, 1.12, 1], opacity: [0.8, 0.2, 0.8] }}
              transition={{ repeat: Infinity, duration: 2.2 }}
            />
          )}
          <Avatar src={profile.photoURL} name={profile.fullName} size={112} ring />
        </motion.div>
        <h1 className="mt-6 text-2xl font-extrabold">{profile.fullName}</h1>
        <p className="font-semibold text-green-mid">{profile.stateCode}</p>

        {!rejected && !profile.photoURL && <AddPhoto uid={profile.uid} />}

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="mt-8 w-full rounded-3xl bg-card p-6 text-left text-ink shadow-lift"
        >
          {rejected ? (
            <div className="text-center">
              <p className="text-lg font-extrabold text-bad">Not approved</p>
              <p className="mt-1 text-sm text-muted">
                An exco could not confirm your details. Speak to your CDS exco with your NYSC ID card.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-lg font-extrabold">Under review</p>
                <motion.span
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ repeat: Infinity, duration: 1.6 }}
                  className="rounded-full bg-warn-bg px-3 py-1 text-xs font-bold text-warn"
                >
                  Waiting for exco
                </motion.span>
              </div>
              <ol className="mt-5 space-y-4">
                {steps.map((s, i) => {
                  const done = i === 0;
                  const now = i === 1;
                  return (
                    <li key={s.t} className="flex gap-3">
                      <span
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-extrabold ${
                          done ? 'bg-green text-white' : now ? 'bg-warn-bg text-warn' : 'bg-line text-muted'
                        }`}
                      >
                        {done ? '✓' : i + 1}
                      </span>
                      <div>
                        <p className={`font-bold ${!done && !now ? 'text-muted' : ''}`}>{s.t}</p>
                        <p className="text-sm text-muted">{s.d}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-5 rounded-2xl bg-paper p-3 text-sm text-muted">
                This screen updates by itself the moment you're approved. You can close the app and come back later.
              </p>
            </>
          )}
        </motion.div>

        <div className="mt-auto w-full pt-8">
          <Button variant="light" onClick={logout}>
            Log out
          </Button>
        </div>
      </div>
    </div>
  );
}
```

---

### `web/src/pages/Signup.tsx`

```tsx
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PhotoPicker } from '../components/PhotoPicker';
import { Button, Checkbox, ErrorBox, Field, TopBar } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { auth, errorText, wakeServer } from '../lib/firebase';
import { PLATFORM_ADMIN_STATE_CODE } from '../lib/appConfig';
import { normalizePhone, normalizeStateCode, stateCodeToEmail } from '../lib/rules';
import { setSignupLock } from '../lib/signupLock';
import { blobToDataUrl, clearDraft, dataUrlToBlob, loadDraft, markPickerOpen, saveDraft } from '../lib/signupDraft';
import { toast } from '../lib/toast';
import { uploadAvatar } from '../lib/upload';

/** State code is recoverable from the hidden login email (la26b1142@cdspass.app). */
function stateCodeFromCurrentUser(): string {
  const local = auth.currentUser?.email?.split('@')[0] ?? '';
  return normalizeStateCode(local) ?? '';
}

export default function Signup({ finish = false }: { finish?: boolean }) {
  const { logout, profile: savedProfile, claims } = useAuth();
  const navigate = useNavigate();
  // Anything typed before the phone closed the app (see lib/signupDraft.ts). Read once.
  const [draft] = useState(() => {
    const d = loadDraft();
    // In "finish" mode the login already exists: only reuse a draft for the same state code.
    if (d && finish && normalizeStateCode(d.stateCode) !== stateCodeFromCurrentUser()) return null;
    return d;
  });
  const steps = finish ? ['Details', 'Photo', 'CDS group'] : ['Details', 'Photo', 'CDS group', 'PIN'];
  const [rawStep, setStep] = useState(draft?.step ?? 0);
  // If sign-up switches to "finish" mode (fewer steps), never point past the last step.
  const step = Math.min(rawStep, steps.length - 1);
  const [dir, setDir] = useState(1);

  const [stateCode, setStateCode] = useState(finish ? stateCodeFromCurrentUser() : draft?.stateCode ?? '');
  const [fullName, setFullName] = useState(draft?.fullName ?? '');
  const [phone, setPhone] = useState(draft?.phone ?? '');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [joinCode, setJoinCode] = useState(draft?.joinCode ?? '');
  // Only the platform admin may start a brand-new group while signing up (first-time setup).
  const [startGroup, setStartGroup] = useState(draft?.startGroup ?? false);
  const [group, setGroup] = useState(draft?.group ?? { name: '', lga: '', state: '' });
  const isPlatformAdmin = normalizeStateCode(stateCode) === PLATFORM_ADMIN_STATE_CODE;
  const creatingGroup = isPlatformAdmin && startGroup;
  /** Set once the server has saved everything; we then wait for the profile to arrive before leaving. */
  const [doneTo, setDoneTo] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [consent, setConsent] = useState(false);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /** The phone closed the app while the camera/gallery was open. */
  const [wasClosed] = useState(() => !!draft?.pickerOpen);
  const [photoData, setPhotoData] = useState<string | null>(draft?.photo ?? null);

  // Bring back a photo that was already chosen before the app was closed.
  useEffect(() => {
    if (draft?.photo) void dataUrlToBlob(draft.photo).then(setPhoto).catch(() => setPhotoData(null));
  }, [draft]);

  // Save progress on every change (never the PIN).
  useEffect(() => {
    if (doneTo) return;
    saveDraft({ step: rawStep, stateCode, fullName, phone, joinCode, startGroup, group, photo: photoData, pickerOpen: false });
  }, [rawStep, stateCode, fullName, phone, joinCode, startGroup, group, photoData, doneTo]);

  // Wake the free Render server now, so it is ready by the time the form is submitted.
  useEffect(() => wakeServer(), []);

  // Never leave the sign-up lock on if this screen goes away (e.g. log out).
  useEffect(() => () => setSignupLock(false), []);

  // Leave only when the saved profile (and, for excos, the new permissions) has reached this phone.
  // Leaving earlier made the app flash back to "Finish signing up".
  useEffect(() => {
    if (!doneTo) return;
    const profileReady = !!savedProfile;
    const excoReady = savedProfile?.status !== 'approved' || (claims.approved === true && claims.role === savedProfile.role);
    const go = () => {
      clearDraft();
      setSignupLock(false);
      navigate(doneTo, { replace: true });
    };
    if (profileReady && excoReady) {
      go();
      return;
    }
    const t = setTimeout(go, 12000); // safety net: never stay stuck on this screen
    return () => clearTimeout(t);
  }, [doneTo, savedProfile, claims.approved, claims.role, navigate]);

  function validate(i: number): string {
    if (i === 0) {
      if (!normalizeStateCode(stateCode)) return 'Enter your state code like LA/26B/1142.';
      if (fullName.trim().length < 3) return 'Enter your full name exactly as it is on your NYSC ID card.';
      if (!normalizePhone(phone)) return 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.';
    }
    if (i === 1 && !photo) return 'Add a profile picture.';
    if (i === 2) {
      if (creatingGroup) {
        if (group.name.trim().length < 3 || group.lga.trim().length < 2 || group.state.trim().length < 2)
          return 'Fill in the CDS group name, LGA and state.';
      } else if (joinCode.trim().length !== 6) return 'Enter the 6-character CDS group code from your exco.';
    }
    if (i === 3) {
      if (!/^\d{6}$/.test(pin)) return 'Your PIN must be 6 digits.';
      if (pin !== pin2) return 'The two PINs do not match.';
      if (!consent) return 'Please agree before creating your account.';
    }
    return '';
  }

  function next() {
    const err = validate(step);
    setError(err);
    if (err) return;
    if (step < steps.length - 1) {
      setDir(1);
      setStep(step + 1);
    } else {
      void submit();
    }
  }

  function back() {
    setError('');
    setDir(-1);
    setStep(Math.max(0, step - 1));
  }

  async function submit() {
    const sc = normalizeStateCode(stateCode)!;
    setError('');
    setSignupLock(finish ? 'finish' : 'signup');
    try {
      let uid = auth.currentUser?.uid;
      if (!uid) {
        setBusy('Creating your account…');
        uid = (await createUserWithEmailAndPassword(auth, stateCodeToEmail(sc), pin)).user.uid;
      }

      setBusy('Uploading your photo…');
      let photoURL: string | null = null;
      try {
        photoURL = await uploadAvatar(uid, photo!);
      } catch (e) {
        // Don't let a slow photo upload block the whole sign-up. They add it on the next screen.
        if ((e as Error).message === 'Please log in again.') throw e;
        toast("Your photo didn't upload", 'error', "Your account is still being created. You'll add the photo on the next screen.");
      }

      setBusy('Saving your details…');
      const profile = { stateCode: sc, fullName: fullName.trim(), phone: normalizePhone(phone)!, photoURL };
      let to = '/pending';
      try {
        const r = creatingGroup
          ? await api.registerPlatformAdmin({ ...profile, group })
          : await api.registerMember({ ...profile, joinCode: joinCode.trim().toUpperCase() });
        if (r.status === 'approved' && r.role === 'exco') {
          to = '/exco';
          if ('joinCode' in r) toast(`${r.groupName} is ready`, 'success', `Share group code ${r.joinCode} with your members.`);
          else toast(`You are the main exco for ${r.groupName}`, 'success', 'You can now set up the group and promote other members.');
        } else {
          toast(`Joined ${r.groupName}`, 'success', 'An exco will approve you at your next CDS.');
        }
      } catch (e) {
        // A slow first try may have finished on the server after the phone gave up. Then the profile
        // already exists, and that is a success, not an error.
        if ((e as { code?: string }).code !== 'functions/already-exists' || !/already registered/i.test(String((e as Error).message))) throw e;
      }
      setBusy('Opening your account…');
      setDoneTo(to);
    } catch (e) {
      // The login may exist now even though the profile doesn't. Keep everything typed so far and
      // let them press the button again; it continues from where it stopped.
      setSignupLock(auth.currentUser ? 'finish' : false);
      setError(errorText(e));
      setBusy('');
    }
  }

  return (
    <div className="screen">
      <TopBar
        title={finish ? 'Finish signing up' : 'Create account'}
        back={step === 0 ? (finish ? undefined : '/') : undefined}
        right={
          finish ? (
            <button onClick={logout} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold">
              Log out
            </button>
          ) : undefined
        }
        sub={`Step ${step + 1} of ${steps.length} · ${steps[step]}`}
      />

      <div className="px-5 pt-4">
        <div className="flex gap-1.5">
          {steps.map((s, i) => (
            <div key={s} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${i <= step ? 'bg-green' : 'bg-line'}`} />
          ))}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden px-5 pt-6">
        {/* Enter-only animation: a step can never get stuck half-way out (that caused the blank PIN screen). */}
        <motion.div
            key={step}
            initial={{ x: dir * 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="space-y-5"
          >
            {step === 0 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Your NYSC details</h2>
                  <p className="text-muted">Your state code is what you log in with.</p>
                </div>
                <Field
                  label="State code"
                  placeholder="LA/26B/1142"
                  autoCapitalize="characters"
                  value={stateCode}
                  disabled={finish}
                  onChange={(e) => setStateCode(e.target.value)}
                />
                <Field
                  label="Full name (as on your NYSC ID card)"
                  placeholder="Adebayo Tolulope Grace"
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
                <Field
                  label="Phone number"
                  type="tel"
                  inputMode="tel"
                  placeholder="0803 123 4567"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </>
            )}

            {step === 1 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Profile picture</h2>
                  <p className="text-muted">This shows on the exco's screen when you thumbprint.</p>
                </div>
                {wasClosed && !photo && (
                  <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
                    Your phone closed the app while the camera was open, but your details are saved. Try
                    <b> Choose photo</b> and pick a selfie from your gallery: it uses less memory.
                  </p>
                )}
                <PhotoPicker
                  value={photo}
                  onPickerOpen={markPickerOpen}
                  onChange={(b, err) => {
                    setPhoto(b);
                    setError(err ?? '');
                    if (b) void blobToDataUrl(b).then(setPhotoData).catch(() => setPhotoData(null));
                    else setPhotoData(null);
                  }}
                />
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Your CDS group</h2>
                  <p className="text-muted">Ask your CDS exco for the group code.</p>
                </div>
                {isPlatformAdmin && (
                  <div className="grid grid-cols-2 gap-2 rounded-2xl bg-line p-1.5">
                    {[false, true].map((m) => (
                      <button
                        key={String(m)}
                        type="button"
                        onClick={() => setStartGroup(m)}
                        className={`h-12 rounded-xl text-sm font-bold transition-colors ${startGroup === m ? 'bg-green text-white shadow-card' : 'text-muted'}`}
                      >
                        {m ? 'Start my CDS group' : 'Join with code'}
                      </button>
                    ))}
                  </div>
                )}
                {creatingGroup ? (
                  <>
                    <Field label="CDS group name" placeholder="Digital Skills CDS" value={group.name} onChange={(e) => setGroup({ ...group, name: e.target.value })} />
                    <Field label="LGA" placeholder="Ikorodu" value={group.lga} onChange={(e) => setGroup({ ...group, lga: e.target.value })} />
                    <Field label="State" placeholder="Lagos" value={group.state} onChange={(e) => setGroup({ ...group, state: e.target.value })} />
                    <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
                      Platform admin setup: you become this group's main exco. Create other groups later in Exco → Settings.
                    </p>
                  </>
                ) : (
                  <Field
                    label="CDS group code"
                    placeholder="K7Q2MX"
                    autoCapitalize="characters"
                    maxLength={6}
                    className="input text-center text-2xl font-extrabold tracking-[0.4em]"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  />
                )}
              </>
            )}

            {step === 3 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Create a 6-digit PIN</h2>
                  <p className="text-muted">You'll log in with your state code and this PIN.</p>
                </div>
                <Field
                  label="PIN"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="new-password"
                  placeholder="••••••"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                />
                <Field
                  label="Confirm PIN"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="new-password"
                  placeholder="••••••"
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
                />
                <Checkbox checked={consent} onChange={setConsent} className="rounded-2xl bg-card p-4 text-sm shadow-card">
                  I agree that my name, state code, phone number and photo are stored by CDS Pass and shown to my
                  CDS excos for attendance only. CDS Pass is an independent tool, not run by NYSC.
                </Checkbox>
              </>
            )}
          </motion.div>
      </div>

      <div className="space-y-3 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
        <ErrorBox>{error}</ErrorBox>
        {busy ? (
          <Button loading>{busy}</Button>
        ) : (
          <div className="flex gap-3">
            {step > 0 && (
              <Button variant="outline" full={false} className="w-28" onClick={back}>
                Back
              </Button>
            )}
            <Button onClick={next}>{step === steps.length - 1 ? 'Create account' : 'Continue'}</Button>
          </div>
        )}
        {busy && <p className="text-center text-sm font-semibold text-muted">{busy}</p>}
        {!finish && step === 0 && (
          <p className="text-center text-sm">
            Already registered?{' '}
            <Link to="/login" className="font-bold text-green">
              Log in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
```

---

### `web/src/pages/Welcome.tsx`

```tsx
import { motion } from 'framer-motion';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { loadDraft } from '../lib/signupDraft';
import { Button } from '../components/ui';
import { canUse3D } from '../lib/device';

const Hero3D = lazy(() => import('../components/Hero3D'));

/** Lightweight stand-in for phones that can't run 3D. */
function FlatHero() {
  return (
    <div className="grid h-full place-items-center">
      <motion.div
        animate={{ y: [0, -10, 0], rotate: [-4, 3, -4] }}
        transition={{ repeat: Infinity, duration: 5, ease: 'easeInOut' }}
        className="flex aspect-[5/7] w-48 flex-col rounded-[26px] bg-gradient-to-br from-green to-green-dark p-5 text-white shadow-lift"
      >
        <span className="text-xs font-extrabold tracking-widest">CDS PASS</span>
        <span className="mt-auto text-center text-xs font-bold tracking-[0.25em] text-green-mid">YOUR NUMBER</span>
        <span className="text-center text-7xl font-extrabold">14</span>
        <span className="mt-auto theme-light rounded-xl bg-white py-2 text-center text-xs font-extrabold text-green">IT'S YOUR TURN ✓</span>
      </motion.div>
    </div>
  );
}

const points = [
  { t: 'Scan in at the door', d: 'Your number is given in the order you arrive. No more queueing for tags.' },
  { t: 'Sit and relax', d: 'Your phone buzzes when your batch is called to thumbprint.' },
  { t: 'Fair for everyone', d: 'Nobody can jump the line. Priority for pregnant and nursing mothers.' },
];

export default function Welcome() {
  const nav = useNavigate();
  const use3D = useMemo(canUse3D, []);
  // The phone closed the app while the camera was open during sign-up: go straight back there.
  const [resume] = useState(() => !!loadDraft()?.pickerOpen);
  if (resume) return <Navigate to="/signup" replace />;

  return (
    <div className="screen hero-green text-white lg:max-w-6xl lg:flex-row">
      <div className="relative h-[46dvh] min-h-[320px] lg:h-auto lg:w-1/2">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(14,127,70,.8),transparent_65%)]" />
        <div className="relative h-full">
          {use3D ? (
            <Suspense fallback={<FlatHero />}>
              <Hero3D />
            </Suspense>
          ) : (
            <FlatHero />
          )}
        </div>
      </div>

      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        className="flex flex-1 flex-col rounded-t-[36px] bg-paper px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-8 text-ink lg:w-1/2 lg:justify-center lg:rounded-none lg:px-14 lg:py-14"
      >
        <h1 className="text-[34px] font-extrabold leading-[1.05] tracking-tight lg:text-5xl">
          No more queueing
          <br />
          <span className="text-green">for numbers at CDS.</span>
        </h1>
        <span className="mt-3 block h-1.5 w-16 rounded-full bg-gold" />

        <ul className="mt-5 space-y-2.5">
          {points.map((p, i) => (
            <motion.li
              key={p.t}
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.15 + i * 0.1 }}
              className={`flex gap-3 rounded-2xl p-3 ${i === 0 ? 'bg-green-light' : i === 1 ? 'bg-card shadow-card' : 'bg-gold-bg'}`}
            >
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl font-display text-sm font-extrabold ${
                  i === 0 ? 'bg-green text-white' : i === 1 ? 'bg-green-light text-green' : 'bg-gold-bg text-gold-text'
                }`}
              >
                {i + 1}
              </span>
              <div>
                <p className="font-bold">{p.t}</p>
                <p className="text-sm text-muted">{p.d}</p>
              </div>
            </motion.li>
          ))}
        </ul>

        <div className="mt-auto space-y-3 pt-8 lg:mt-10 lg:max-w-sm">
          <Button variant="gold" onClick={() => nav('/signup')}>
            Get started
          </Button>
          <Button variant="outline" onClick={() => nav('/login')}>
            I already have an account
          </Button>
          <p className="pt-2 text-center text-xs text-muted">Independent tool for CDS groups. Not affiliated with NYSC.</p>
        </div>
      </motion.div>
    </div>
  );
}
```

---

### `web/src/pages/admin/Admin.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Button, Checkbox, ErrorBox, Field, Icon, Page, Pill, Select, Stat } from '../../components/ui';
import { usePlatformRole } from '../../hooks/usePlatform';
import { api, type AdminConfig, type AdminGroupRow, type AdminOverview } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { naira } from '../../lib/money';
import { toast } from '../../lib/toast';
import { TrendChart } from './Charts';

type Tab = 'overview' | 'groups' | 'controls' | 'message' | 'team';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const nairaShort = (kobo: number) => {
  const n = kobo / 100;
  return n >= 1_000_000 ? `₦${(n / 1_000_000).toFixed(1)}m` : n >= 1000 ? `₦${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `₦${Math.round(n)}`;
};

/* ---------------------------------------------------------------- overview */

function Overview({ data }: { data: AdminOverview }) {
  const s = data.series;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat tone="light" value={data.totals.groups} label={`CDS groups · ${data.totals.activeGroups} met this month`} />
        <Stat tone="light" value={data.totals.members.toLocaleString()} label={`Members · ${data.totals.pending} waiting`} />
        <Stat tone="light" value={data.totals.checkins30.toLocaleString()} label="Check-ins (30 days)" />
        <Stat tone="gold" value={naira(data.totals.earnedKobo)} label="Your earnings (all time)" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <TrendChart title="New sign-ups per day" days={s.days} values={s.signups} kind="line" total={`${sum(s.signups)} in 30 days`} />
        <TrendChart title="Check-ins per CDS day" days={s.days} values={s.checkins} kind="bar" total={`${sum(s.checkins)} in 30 days`} />
        <TrendChart
          title="Dues collected per day"
          days={s.days}
          values={s.paidKobo}
          kind="bar"
          format={nairaShort}
          total={naira(sum(s.paidKobo))}
        />
        <TrendChart
          title="Your earnings per day (3% fee)"
          days={s.days}
          values={s.earnedKobo}
          kind="line"
          format={nairaShort}
          total={naira(sum(s.earnedKobo))}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat tone="light" value={naira(data.totals.onlineKobo)} label="Dues paid online (all time)" />
        <Stat tone="light" value={naira(data.totals.cashKobo)} label="Cash recorded (all time)" />
      </div>
      <p className="text-center text-xs text-muted">
        Updated {new Date(data.generatedAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}. Figures refresh every 5 minutes.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- groups */

function Groups({ data, canEdit, onChanged }: { data: AdminOverview; canEdit: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.groups.filter((g) => !t || `${g.name} ${g.lga} ${g.state} ${g.joinCode}`.toLowerCase().includes(t));
  }, [data.groups, q]);

  async function pause(g: AdminGroupRow) {
    const next = !g.paused;
    if (!confirm(next ? `Pause ${g.name}? Members can't check in or pay until you resume it.` : `Resume ${g.name}?`)) return;
    setBusy(g.id);
    try {
      await api.adminSetGroupPaused({ gid: g.id, paused: next });
      toast(next ? `${g.name} paused` : `${g.name} resumed`, 'success');
      onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-3">
      <input className="input" placeholder="Search group, LGA, state or code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search groups" />
      {list.length === 0 && <p className="card text-center text-sm text-muted">No groups match.</p>}
      {list.map((g) => (
        <div key={g.id} className="card !p-0">
          <button onClick={() => setOpen(open === g.id ? null : g.id)} className="flex w-full items-center gap-3 p-4 text-left">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl font-display font-extrabold ${g.paused ? 'bg-bad-bg text-bad' : 'bg-green-light text-green'}`}>
              {g.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{g.name}</span>
              <span className="block truncate text-xs text-muted">
                {g.lga}, {g.state} · {g.members} members{g.pending ? ` · ${g.pending} waiting` : ''}
              </span>
            </span>
            {g.paused ? <Pill tone="bad">Paused</Pill> : g.lastMeeting ? <Pill>Active</Pill> : <Pill tone="muted">No meeting</Pill>}
          </button>
          <AnimatePresence>
            {open === g.id && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="space-y-3 border-t border-line p-4">
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                    <Info k="Group code" v={g.joinCode} />
                    <Info k="Main exco" v={g.mainExcoStateCode ?? '—'} />
                    <Info k="Excos" v={String(g.excos)} />
                    <Info k="Last meeting" v={g.lastMeeting ? `${g.lastMeeting} · ${g.lastCheckins} in` : '—'} />
                    <Info k="Missing photos" v={String(g.noPhoto)} />
                    <Info k="Paid online" v={naira(g.onlineKobo)} />
                    <Info k="Cash recorded" v={naira(g.cashKobo)} />
                    <Info k="Your earnings" v={naira(g.earnedKobo)} />
                  </div>
                  {canEdit && (
                    <Button variant={g.paused ? 'primary' : 'outline'} loading={busy === g.id} onClick={() => pause(g)}>
                      {g.paused ? 'Resume this group' : 'Pause this group'}
                    </Button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-paper px-3 py-2">
      <p className="text-[11px] font-semibold text-muted">{k}</p>
      <p className="truncate font-bold">{v}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- controls */

function Controls({ config, canEdit, onSaved }: { config: AdminConfig; canEdit: boolean; onSaved: () => void }) {
  const [banner, setBanner] = useState(config.banner ?? '');
  const [maintenance, setMaintenance] = useState(config.maintenance ?? '');
  const [busy, setBusy] = useState('');

  async function save(key: string, patch: Parameters<typeof api.adminSetConfig>[0], done: string) {
    setBusy(key);
    try {
      await api.adminSetConfig(patch);
      toast(done, 'success');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      {!canEdit && <p className="rounded-2xl bg-gold-bg px-4 py-3 text-sm text-gold-text">You have view-only access.</p>}
      <div className="card space-y-3">
        <p className="font-bold">Switches</p>
        <Checkbox
          checked={config.signupsPaused}
          onChange={(v) => canEdit && save('signups', { signupsPaused: v }, v ? 'New sign-ups paused' : 'Sign-ups open again')}
          className="rounded-2xl bg-paper p-3 text-sm"
        >
          <span className="font-bold">Pause new sign-ups</span>
          <span className="block text-xs text-muted">Existing members keep working.</span>
        </Checkbox>
        <Checkbox
          checked={config.paymentsPaused}
          onChange={(v) => canEdit && save('payments', { paymentsPaused: v }, v ? 'Online payments paused' : 'Online payments back on')}
          className="rounded-2xl bg-paper p-3 text-sm"
        >
          <span className="font-bold">Pause online payments</span>
          <span className="block text-xs text-muted">Members can still pay cash to excos.</span>
        </Checkbox>
      </div>

      <div className="card space-y-3">
        <p className="font-bold">Announcement banner</p>
        <p className="text-sm text-muted">A gold bar at the top of everyone's app. Leave empty to remove it.</p>
        <Field label="Banner text" maxLength={200} placeholder="New: pay your dues online in CDS Pass" value={banner} onChange={(e) => setBanner(e.target.value)} />
        <Button variant="gold" disabled={!canEdit} loading={busy === 'banner'} onClick={() => save('banner', { banner: banner.trim() || null }, banner.trim() ? 'Banner is live' : 'Banner removed')}>
          {banner.trim() ? 'Show banner' : 'Remove banner'}
        </Button>
      </div>

      <div className="card space-y-3">
        <p className="font-bold">Maintenance mode</p>
        <p className="text-sm text-muted">Everyone except the admin team sees an “updating” screen. Use while you upload a big update.</p>
        <Field label="Message" maxLength={200} placeholder="CDS Pass is updating. Back in 10 minutes." value={maintenance} onChange={(e) => setMaintenance(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={!canEdit || !maintenance.trim()}
            loading={busy === 'mOn'}
            onClick={() => confirm('Turn maintenance ON for everyone?') && save('mOn', { maintenance: maintenance.trim() }, 'Maintenance is ON')}
          >
            Turn on
          </Button>
          <Button disabled={!canEdit || !config.maintenance} loading={busy === 'mOff'} onClick={() => save('mOff', { maintenance: null }, 'Maintenance is OFF')}>
            Turn off
          </Button>
        </div>
        {config.maintenance && <Pill tone="bad">Maintenance is ON now</Pill>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- broadcast */

function Broadcast({ data, canEdit }: { data: AdminOverview; canEdit: boolean }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'everyone' | 'excos'>('everyone');
  const [target, setTarget] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    setError('');
    const where = target === 'all' ? 'ALL CDS groups' : data.groups.find((g) => g.id === target)?.name;
    if (!confirm(`Send "${title}" to ${audience === 'excos' ? 'excos' : 'everyone'} in ${where}?`)) return;
    setBusy(true);
    try {
      const r = await api.adminBroadcast({ title, body, audience, gids: target === 'all' ? [] : [target], link: '/home' });
      toast(`Sent to ${r.recipients} people`, 'success');
      setTitle('');
      setBody('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <Select
        label="Which CDS groups"
        value={target}
        onChange={setTarget}
        options={[{ value: 'all', label: 'All CDS groups' }, ...data.groups.map((g) => ({ value: g.id, label: g.name, hint: `${g.lga} · ${g.members} members` }))]}
      />
      <Select<'everyone' | 'excos'>
        label="Who"
        value={audience}
        onChange={setAudience}
        options={[
          { value: 'everyone', label: 'Everyone (approved members)' },
          { value: 'excos', label: 'Excos only' },
        ]}
      />
      <Field label="Title" maxLength={60} placeholder="New on CDS Pass" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div>
        <label htmlFor="b-body" className="label">
          Message
        </label>
        <textarea id="b-body" rows={4} maxLength={300} className="input !h-auto resize-none py-3" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <ErrorBox>{error}</ErrorBox>
      <Button disabled={!canEdit || title.trim().length < 3 || body.trim().length < 3} loading={busy} onClick={send}>
        <Icon name="bell" /> Send to {target === 'all' ? 'all groups' : 'this group'}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- team */

function Team({ config, onSaved }: { config: AdminConfig; onSaved: () => void }) {
  const [sc, setSc] = useState('');
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');
  const [busy, setBusy] = useState('');

  async function set(stateCode: string, r: 'viewer' | 'admin' | null) {
    setBusy(stateCode);
    try {
      await api.adminSetTeamMember({ stateCode, role: r });
      toast(r ? 'Team updated' : 'Removed from the team', 'success');
      setSc('');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <p className="font-bold">Admin team</p>
        <p className="text-sm text-muted">
          <b>Viewer</b>: sees charts and all groups. <b>Admin</b>: can also use switches, pause groups, send messages and create groups. Only you
          (owner {config.owner}) can change the team.
        </p>
        <ul className="divide-y divide-line">
          <li className="flex items-center justify-between py-2 text-sm">
            <span className="font-bold">{config.owner}</span>
            <Pill tone="gold">Owner</Pill>
          </li>
          {config.team.map((m) => (
            <li key={m.stateCode} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="font-bold">{m.stateCode}</span>
              <span className="flex items-center gap-2">
                <Pill tone={m.role === 'admin' ? 'green' : 'muted'}>{m.role === 'admin' ? 'Admin' : 'Viewer'}</Pill>
                <button
                  disabled={busy === m.stateCode}
                  onClick={() => confirm(`Remove ${m.stateCode} from the team?`) && set(m.stateCode, null)}
                  className="text-xs font-bold text-bad"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card space-y-3">
        <p className="font-bold">Add someone</p>
        <Field label="Their state code" placeholder="LA/26B/1234" autoCapitalize="characters" value={sc} onChange={(e) => setSc(e.target.value)} />
        <Select<'viewer' | 'admin'>
          label="Access"
          value={role}
          onChange={setRole}
          options={[
            { value: 'viewer', label: 'Viewer (see only)', hint: 'Best for a partner' },
            { value: 'admin', label: 'Admin (can change things)' },
          ]}
        />
        <Button loading={busy === sc && !!sc} disabled={sc.trim().length < 8} onClick={() => set(sc.trim(), role)}>
          Add to team
        </Button>
        <p className="text-xs text-muted">They need a CDS Pass account. After you add them, they log out and in again to see Admin mode.</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export default function Admin() {
  const role = usePlatformRole();
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const [o, c] = await Promise.all([api.adminOverview({ refresh }), api.adminGetConfig({})]);
      setData(o);
      setConfig(c);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (role === null && error) return <Navigate to="/home" replace />;
  const canEdit = config?.role === 'owner' || config?.role === 'admin';
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'groups', label: 'Groups' },
    { id: 'controls', label: 'Controls' },
    { id: 'message', label: 'Message' },
    ...(config?.role === 'owner' ? [{ id: 'team' as Tab, label: 'Team' }] : []),
  ];

  return (
    <div className="min-h-[100dvh] bg-paper text-ink">
      <header className="hero-green px-5 pb-6 pt-[max(env(safe-area-inset-top),20px)] text-white">
        <div className="mx-auto max-w-5xl">
          <p className="text-sm text-green-mid">🛡️ Admin mode{config ? ` · ${config.role}` : ''}</p>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-extrabold">CDS Pass control room</h1>
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="mr-24 h-9 shrink-0 rounded-full bg-white/15 px-3 text-xs font-bold disabled:opacity-50 lg:mr-28"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          <div className="mt-4 flex gap-1 overflow-x-auto rounded-2xl bg-white/10 p-1">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`relative h-10 shrink-0 flex-1 rounded-xl px-3 text-sm font-bold ${tab === t.id ? 'text-brand' : 'text-white'}`}>
                {tab === t.id && <motion.span layoutId="admin-tab" className="absolute inset-0 rounded-xl bg-white" />}
                <span className="relative">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>
      <Page className="mx-auto max-w-5xl space-y-4 pb-16">
        <ErrorBox>{error}</ErrorBox>
        {!data || !config ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card h-48 animate-pulse" />
            ))}
          </div>
        ) : tab === 'overview' ? (
          <Overview data={data} />
        ) : tab === 'groups' ? (
          <Groups data={data} canEdit={canEdit} onChanged={() => load(true)} />
        ) : tab === 'controls' ? (
          <Controls key={JSON.stringify(config)} config={config} canEdit={canEdit} onSaved={() => load()} />
        ) : tab === 'message' ? (
          <Broadcast data={data} canEdit={canEdit} />
        ) : (
          <Team config={config} onSaved={() => load()} />
        )}
      </Page>
    </div>
  );
}
```

---

### `web/src/pages/admin/Charts.tsx`

```tsx
import { useMemo, useState } from 'react';

/**
 * Small single-series charts for Admin mode (no chart library: keeps the app light).
 * One series each, so no legend: the title names it. Marks use our green (brighter in dark mode),
 * grid and axes stay quiet, and hovering / tapping shows the exact value for that day.
 */

const W = 320;
const H = 140;
const PAD = { l: 34, r: 8, t: 10, b: 22 };

const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export function TrendChart({
  title,
  days,
  values,
  kind = 'line',
  format = (n) => n.toLocaleString('en-NG'),
  total,
}: {
  title: string;
  days: string[];
  values: number[];
  kind?: 'line' | 'bar';
  format?: (n: number) => string;
  total?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => niceMax(Math.max(0, ...values)), [values]);
  const n = values.length;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const step = iw / Math.max(1, n);
  const barW = Math.max(2, Math.min(14, step - 2)); // 2px surface gap between bars

  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(n - 1)},${PAD.t + ih} L${x(0)},${PAD.t + ih} Z`;
  const barX = (i: number) => PAD.l + i * step + (step - barW) / 2;

  function pick(clientX: number, el: SVGSVGElement) {
    const r = el.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    const i = kind === 'bar' ? Math.floor((sx - PAD.l) / step) : Math.round(((sx - PAD.l) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  }

  const hx = hover === null ? 0 : kind === 'bar' ? barX(hover) + barW / 2 : x(hover);

  return (
    <figure className="card !p-4">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold">{title}</span>
        {total && <span className="font-display text-lg font-extrabold text-green">{total}</span>}
      </figcaption>
      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full touch-none select-none"
          role="img"
          aria-label={`${title}, last ${n} days`}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={() => setHover(null)}
        >
          {/* quiet grid: 0, half, max */}
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="rgb(var(--line))" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(max * f) + 3} textAnchor="end" fontSize={9} fill="rgb(var(--muted))">
                {format(max * f)}
              </text>
            </g>
          ))}
          {/* x labels: first, middle, last */}
          {[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
            <text key={i} x={kind === 'bar' ? barX(i) + barW / 2 : x(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="rgb(var(--muted))">
              {shortDay(days[i])}
            </text>
          ))}

          {kind === 'line' ? (
            <>
              <path d={area} fill="rgb(var(--green-text) / 0.12)" />
              <path d={path} fill="none" stroke="rgb(var(--green-text))" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>
          ) : (
            values.map((v, i) => {
              const h = Math.max(0, PAD.t + ih - y(v));
              return (
                <rect
                  key={i}
                  x={barX(i)}
                  y={PAD.t + ih - h}
                  width={barW}
                  height={h}
                  rx={Math.min(3, barW / 2)}
                  fill="rgb(var(--green-text))"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              );
            })
          )}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={PAD.t} y2={PAD.t + ih} stroke="rgb(var(--muted))" strokeDasharray="3 3" strokeWidth={1} />
              {kind === 'line' && <circle cx={hx} cy={y(values[hover])} r={4.5} fill="rgb(var(--green-text))" stroke="rgb(var(--card))" strokeWidth={2} />}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-xl bg-ink px-2.5 py-1.5 text-xs font-semibold text-paper shadow-lift"
            style={{ left: `${Math.min(88, Math.max(12, (hx / W) * 100))}%` }}
          >
            {shortDay(days[hover])}: <b>{format(values[hover])}</b>
          </div>
        )}
      </div>
    </figure>
  );
}
```

---

### `web/src/pages/exco/CallBatch.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Page, Pill } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function CallBatch() {
  const { group, session, stats, attendees, open } = useExcoDay();
  const [busy, setBusy] = useState<'' | 'priority' | 'next'>('');
  const [error, setError] = useState('');
  const batch = session?.batch ?? null;
  const size = group?.batchSize ?? 20;
  const nextFrom = (session?.lastTo ?? 0) + 1;
  const lastNumber = Math.max((session?.nextNumber ?? 1) - 1, ...(attendees ?? []).map((a) => a.number), 0);

  const inCurrent =
    batch?.kind === 'regular'
      ? (attendees ?? []).filter((a) => !a.priority && a.number >= batch.from && a.number <= batch.to)
      : batch?.kind === 'priority'
        ? (attendees ?? []).filter((a) => a.priority)
        : [];
  const currentDone = inCurrent.filter((a) => a.status === 'done').length;

  async function call(mode: 'priority' | 'next') {
    setError('');
    setBusy(mode);
    try {
      const r = await api.callNext({ mode });
      toast(`Called ${batchLabel(r.batch)}`, 'success', `${r.notified} phones notified · ${r.inBatch} people in this batch`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <ExcoHeader title="Call batches" sub={`Batch size ${size} · last number given: ${lastNumber}`} />
      <Page className="space-y-4">
        <div className="relative overflow-hidden rounded-[28px] bg-green p-6 text-center text-white shadow-lift">
          <div className="grid-bg absolute inset-0" />
          <p className="relative text-xs font-extrabold tracking-[0.3em] text-green-mid">NOW CALLING</p>
          <AnimatePresence mode="wait">
            <motion.p
              key={batch?.seq ?? 0}
              initial={{ y: 40, opacity: 0, rotateX: -60 }}
              animate={{ y: 0, opacity: 1, rotateX: 0 }}
              exit={{ y: -40, opacity: 0, rotateX: 60 }}
              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
              className="relative text-6xl font-extrabold"
              style={{ textShadow: '0 4px 0 #064726, 0 12px 24px rgba(0,0,0,.3)' }}
            >
              {open ? batchLabel(batch) : session?.status === 'closed' ? 'STOPPED' : '—'}
            </motion.p>
          </AnimatePresence>
          {batch && (
            <p className="relative mt-2 text-sm font-semibold text-green-mid">
              {currentDone} of {inCurrent.length} thumbprinted
            </p>
          )}
        </div>

        {!open && <ErrorBox>Today's meeting is not open.</ErrorBox>}
        {!open && session?.status === 'closed' && (
          <p className="text-center text-sm text-muted">Batch calls and member turn alerts are paused until an exco opens the meeting again.</p>
        )}

        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold">Priority first</p>
            <Pill tone="warn">{stats.priorityWaiting} waiting</Pill>
          </div>
          <p className="text-sm text-muted">Pregnant and nursing mothers with a priority tag can thumbprint any time after this.</p>
          <Button variant="light" className="!bg-warn-bg !text-warn !shadow-none" disabled={!open || stats.priority === 0} loading={busy === 'priority'} onClick={() => call('priority')}>
            Call priority
          </Button>
        </div>

        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold">Next batch</p>
            <Pill>
              {nextFrom} – {nextFrom + size - 1}
            </Pill>
          </div>
          <p className="text-sm text-muted">Phones in this batch buzz. Read the numbers out too, for people with no data.</p>
          <Button disabled={!open || nextFrom > lastNumber} loading={busy === 'next'} onClick={() => call('next')}>
            Call next batch
          </Button>
          {open && nextFrom > lastNumber && <p className="text-center text-xs text-muted">Waiting for more people to check in.</p>}
        </div>

        <ErrorBox>{error}</ErrorBox>
        <p className="text-center text-xs text-muted">
          Anyone from an earlier batch who missed their call can still come up. Later numbers are refused at the table.
        </p>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/Dashboard.tsx`

```tsx
import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Icon, Page, Pill, Stat } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { usePendingMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel, tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function Dashboard() {
  const { me, group, session, attendees, stats, open } = useExcoDay();
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  // Dashboard only needs the waiting count, so it reads just those members (not the whole group).
  const pendingCount = usePendingMembers(me.groupId)?.length ?? 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggleSession() {
    setError('');
    setBusy(true);
    try {
      if (open) {
        if (!confirm("End today's CDS meeting? Nobody else can check in after this.")) return;
        await api.endSession({});
        toast('Meeting closed', 'info');
      } else {
        await api.startSession({});
        toast("Today's meeting is open", 'success', 'Show the door code so members can scan in.');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const today = new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <ExcoHeader title={group?.name ?? 'CDS group'} sub={`${today} · Group code ${group?.joinCode ?? '…'}`}>
        <div className="grid grid-cols-3 gap-2">
          <Stat value={stats.present} label="Present" />
          <Stat value={stats.done} label="Thumbprinted" />
          <Stat value={stats.waiting} label="Waiting" tone="gold" />
        </div>
      </ExcoHeader>

      <Page className="space-y-4">
        <motion.div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold">Today's meeting</p>
              <p className="text-sm text-muted">{open ? 'Open. Members can scan in.' : session ? 'Closed' : 'Not opened yet'}</p>
            </div>
            <Pill tone={open ? 'green' : 'gold'}>{open ? '● Live' : 'Off'}</Pill>
          </div>
          <Button variant={open ? 'outline' : 'primary'} loading={busy} onClick={toggleSession}>
            {open ? 'End meeting' : "Open today's meeting"}
          </Button>
          <ErrorBox>{error}</ErrorBox>
        </motion.div>

        {open && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { to: '/exco/door', icon: 'door', t: 'Door code', d: 'Members scan in', tone: 'solid' },
              { to: '/exco/call', icon: 'megaphone', t: 'Call batch', d: `Now: ${batchLabel(session?.batch)}`, tone: 'gold' },
              { to: '/exco/table', icon: 'finger', t: 'Table check', d: 'Green or red', tone: 'light' },
              { to: '/exco/members', icon: 'users', t: 'Members', d: pendingCount ? `${pendingCount} to approve` : 'All approved', tone: 'gold' },
            ].map((c, i) => (
              <motion.div key={c.to} initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: i * 0.06 }}>
                <Link
                  to={c.to}
                  className={`block rounded-3xl p-4 shadow-card transition active:scale-[0.98] ${
                    c.tone === 'solid' ? 'number-card text-white' : c.tone === 'gold' ? 'bg-gold-bg text-gold-text' : 'bg-green-light text-green'
                  }`}
                >
                  <span className={`grid h-11 w-11 place-items-center rounded-xl ${c.tone === 'solid' ? 'bg-white/15' : 'bg-card shadow-card'}`}>
                    <Icon name={c.icon as Parameters<typeof Icon>[0]['name']} />
                  </span>
                  <p className="mt-3 font-display font-bold">{c.t}</p>
                  <p className={`text-xs ${c.tone === 'solid' ? 'text-green-mid' : 'opacity-80'}`}>{c.d}</p>
                </Link>
              </motion.div>
            ))}
          </div>
        )}

        {isMainExco && (
          <div className="grid grid-cols-2 gap-3">
            <Link to="/exco/messages" className="flex flex-col gap-2 rounded-3xl bg-gold-bg p-4 text-gold-text shadow-card active:scale-[0.98]">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-card shadow-card">
                <Icon name="bell" />
              </span>
              <span className="font-display font-bold">Send a message</span>
              <span className="text-xs opacity-80">To everyone or a group</span>
            </Link>
            <Link
              to="/exco/give-number"
              className={`flex flex-col gap-2 rounded-3xl bg-green-light p-4 text-green shadow-card active:scale-[0.98] ${open ? '' : 'opacity-60'}`}
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-card shadow-card">
                <Icon name="users" />
              </span>
              <span className="font-display font-bold">Give a number</span>
              <span className="text-xs opacity-80">{open ? 'Phone off? Find them' : 'When the meeting is open'}</span>
            </Link>
          </div>
        )}

        <Link to="/exco/dues" className="card flex items-center gap-3 !p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold-bg text-gold-text">
            <Icon name="card" />
          </span>
          <div className="flex-1">
            <p className="font-bold">Dues</p>
            <p className="text-xs text-muted">Bank account, online payments, cash records</p>
          </div>
          <span className="text-green">→</span>
        </Link>

        {!open && pendingCount > 0 && (
          <Link to="/exco/members" className="card flex items-center justify-between !p-4">
            <span className="font-bold">{pendingCount} new members waiting for approval</span>
            <span className="text-green">→</span>
          </Link>
        )}

        {attendees && attendees.length > 0 && (
          <div className="card !p-0">
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <p className="font-bold">Register</p>
              <p className="text-xs text-muted">
                {stats.priority} priority · {stats.manual} manual
              </p>
            </div>
            <ul className="divide-y divide-line">
              {attendees.map((a) => (
                <li key={a.uid} className="flex items-center gap-3 px-5 py-3">
                  <span className={`w-10 text-center font-extrabold ${a.priority ? 'text-warn' : 'text-green'}`}>{tagLabel(a)}</span>
                  <Avatar src={a.photoURL} name={a.fullName} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{a.fullName}</p>
                    <p className="text-xs text-muted">
                      {a.stateCode} · {a.checkedInAt?.toDate().toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}
                      {a.method === 'manual' ? ' · manual' : a.method === 'card' ? ' · card' : ''}
                    </p>
                  </div>
                  <Pill tone={a.status === 'done' ? 'green' : 'muted'}>{a.status === 'done' ? 'Done' : 'Waiting'}</Pill>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/Door.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExcoHeader } from '../../components/ExcoHeader';
import { MemberCard } from '../../components/MemberCard';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Field, Page } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { doorQR, parseQR, tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Attendee, PublicMember } from '../../lib/types';

type Tab = 'code' | 'scan' | 'manual';

/** `epoch` changes when the main exco gives someone a number by hand: fetch a new code at once. */
function DoorCode({ epoch }: { epoch: number }) {
  const [code, setCode] = useState<{ code: string; gid: string; expiresAt: number } | null>(null);
  const [left, setLeft] = useState(30);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const c = await api.getDoorCode({});
      setCode(c);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, epoch]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!code) return;
      const s = Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s <= 2) void refresh();
    }, 500);
    return () => clearInterval(t);
  }, [code, refresh]);

  // Keep the screen awake while showing the code.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release();
  }, []);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!code) return <div className="card h-[420px] animate-pulse" />;

  return (
    <div className="card flex flex-col items-center gap-4 !p-6">
      <p className="text-sm font-bold text-muted">Members scan this to get their number</p>
      <AnimatePresence mode="wait">
        <motion.div
          key={code.code}
          initial={{ rotateY: -90, opacity: 0 }}
          animate={{ rotateY: 0, opacity: 1 }}
          exit={{ rotateY: 90, opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="theme-light rounded-3xl bg-white p-3 ring-8 ring-green-light"
        >
          <QRCodeSVG value={doorQR(code.gid, code.code)} size={250} level="M" fgColor="#03301A" />
        </motion.div>
      </AnimatePresence>
      <div className="text-center">
        <p className="text-xs font-bold tracking-[0.3em] text-muted">OR TYPE</p>
        <p className="text-5xl font-extrabold tracking-[0.2em] text-green">
          {code.code.slice(0, 3)} {code.code.slice(3)}
        </p>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-line">
        <motion.div className="h-full bg-green" animate={{ width: `${(left / 30) * 100}%` }} transition={{ ease: 'linear', duration: 0.5 }} />
      </div>
      <p className="text-xs text-muted">New code in {left}s. Screenshots stop working after that.</p>
    </div>
  );
}

/** Scan a printed card / tag, or type a state code, for members whose phone can't scan. */
function AssistedCheckIn({ mode }: { mode: 'scan' | 'manual' }) {
  const [found, setFound] = useState<{ member: PublicMember; attendee: Attendee | null; uid: string } | null>(null);
  const [stateCode, setStateCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function lookup(who: { uid?: string; stateCode?: string }) {
    setError('');
    setBusy('lookup');
    try {
      const r = await api.lookupMember(who);
      setFound({ ...r, uid: r.member.uid });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function admit() {
    if (!found) return;
    setBusy('admit');
    try {
      // Typed state code = main exco only; it also changes the door code straight away.
      const r = mode === 'scan' ? await api.excoCheckIn({ uid: found.uid, method: 'card' }) : await api.giveNextNumber({ uid: found.uid });
      toast(r.already ? `Already No. ${r.number}` : `Checked in · No. ${r.number}`, 'success', found.member.fullName);
      await lookup({ uid: found.uid });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function priority() {
    if (!found) return;
    setBusy('priority');
    try {
      const r = await api.setPriority({ uid: found.uid });
      toast(`Priority tag P${r.pNumber}`, 'success', found.member.fullName);
      setFound({ ...found, attendee: { ...(found.attendee as Attendee), priority: true, pNumber: r.pNumber } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  const reset = () => {
    setFound(null);
    setStateCode('');
    setError('');
  };

  return (
    <div className="space-y-4">
      {!found && mode === 'scan' && (
        <QRScan
          className="aspect-square w-full"
          paused={!!busy}
          onResult={(t) => {
            const q = parseQR(t);
            if (q?.type === 'member') void lookup({ uid: q.uid });
            else setError('That is not a CDS Pass member tag or card.');
          }}
        />
      )}
      {!found && mode === 'manual' && (
        <div className="card space-y-4">
          <Field label="State code" placeholder="LA/26B/1142" autoCapitalize="characters" value={stateCode} onChange={(e) => setStateCode(e.target.value)} />
          <Button loading={busy === 'lookup'} onClick={() => lookup({ stateCode })}>
            Find member
          </Button>
          <p className="text-xs text-muted">Main exco only. Logged with your name, and the door code changes straight after.</p>
        </div>
      )}

      <ErrorBox>{error}</ErrorBox>

      <AnimatePresence>
        {found && (
          <MemberCard
            member={found.member}
            tone={found.member.status !== 'approved' ? 'warn' : found.attendee ? 'ok' : 'neutral'}
            headline={found.attendee ? `No. ${tagLabel(found.attendee)}` : found.member.status !== 'approved' ? 'Not approved yet' : 'Not checked in'}
            detail={found.member.status !== 'approved' ? 'Approve them in Members first.' : undefined}
          >
            {found.member.status === 'approved' && !found.attendee && (
              <Button loading={busy === 'admit'} onClick={admit}>
                Check in (next number)
              </Button>
            )}
            {found.attendee && !found.attendee.priority && (
              <Button variant="light" loading={busy === 'priority'} onClick={priority}>
                Give priority tag (pregnant / nursing mother)
              </Button>
            )}
            {found.member.status !== 'approved' && (
              <Link to="/exco/members" className="block rounded-2xl bg-card py-4 text-center font-bold text-green">
                Go to approvals
              </Link>
            )}
            <Button variant={found.attendee ? 'light' : 'outline'} onClick={reset}>
              Next person
            </Button>
          </MemberCard>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Door() {
  const { me, group, session, open, stats } = useExcoDay();
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  const [tab, setTab] = useState<Tab>('code');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'code', label: 'Door code' },
    { id: 'scan', label: 'Scan card' },
    ...(isMainExco ? [{ id: 'manual' as Tab, label: 'State code' }] : []),
  ];

  return (
    <>
      <ExcoHeader title="Door check-in" sub={`${stats.present} checked in so far`}>
        <div className={`grid gap-1 rounded-2xl bg-white/10 p-1 ${tabs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`relative h-11 rounded-xl text-sm font-bold ${tab === t.id ? 'text-brand' : 'text-white'}`}>
              {tab === t.id && <motion.span layoutId="door-tab" className="absolute inset-0 rounded-xl bg-white" />}
              <span className="relative">{t.label}</span>
            </button>
          ))}
        </div>
      </ExcoHeader>
      <Page>
        {!open ? (
          <div className="card text-center">
            <p className="font-bold">Today's meeting is not open</p>
            <Link to="/exco" className="mt-3 inline-block font-bold text-green">
              Open it from Today →
            </Link>
          </div>
        ) : tab === 'code' ? (
          <DoorCode epoch={session?.doorEpoch ?? 0} />
        ) : (
          <AssistedCheckIn key={tab} mode={tab} />
        )}
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/DuesAdmin.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, Checkbox, ErrorBox, Field, Icon, Page, Pill, Select, Stat } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useActiveDues, useDuesStatuses, useGroup, useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { naira } from '../../lib/money';
import { toast } from '../../lib/toast';
import type { Dues } from '../../lib/types';

/** Where the money goes: a bank account checked with Paystack. */
function PayoutAccount() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const [editing, setEditing] = useState(false);
  const [banks, setBanks] = useState<{ name: string; code: string }[] | null>(null);
  const [bankCode, setBankCode] = useState('');
  const [acct, setAcct] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!editing || banks) return;
    api
      .listBanks({})
      .then(setBanks)
      .catch((e) => setError(errorText(e)));
  }, [editing, banks]);

  useEffect(() => {
    setName('');
    if (acct.length !== 10 || !bankCode) return;
    setBusy('resolve');
    setError('');
    api
      .resolveAccount({ bankCode, accountNumber: acct })
      .then((r) => setName(r.accountName))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(''));
  }, [acct, bankCode]);

  async function save() {
    setBusy('save');
    setError('');
    try {
      const bankName = banks?.find((b) => b.code === bankCode)?.name ?? '';
      await api.setPayoutAccount({ bankCode, bankName, accountNumber: acct });
      toast('Dues account saved', 'success', name);
      setEditing(false);
      setAcct('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-green-light text-green">
          <Icon name="bank" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">Dues account</p>
          <p className="truncate text-sm text-muted">
            {group?.payout
              ? `${group.payout.accountName} · ${group.payout.bankName} ****${group.payout.last4}`
              : 'Not set. Members cannot pay online yet.'}
          </p>
        </div>
        {!editing && (
          <button onClick={() => setEditing(true)} className="rounded-xl px-3 py-2 text-sm font-bold text-green">
            {group?.payout ? 'Change' : 'Add'}
          </button>
        )}
      </div>

      <AnimatePresence>
        {editing && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-3 overflow-hidden">
            <Select
              inline
              label="Bank"
              value={bankCode}
              onChange={setBankCode}
              disabled={!banks}
              placeholder={banks ? 'Choose bank' : 'Loading banks…'}
              options={(banks ?? []).map((b) => ({ value: b.code, label: b.name }))}
            />
            <Field
              label="Account number"
              inputMode="numeric"
              maxLength={10}
              placeholder="0123456789"
              value={acct}
              onChange={(e) => setAcct(e.target.value.replace(/\D/g, ''))}
              hint={busy === 'resolve' ? 'Checking account…' : name ? `✓ ${name}` : 'Usually the treasurer’s account. Members will see this name.'}
            />
            <ErrorBox>{error}</ErrorBox>
            <div className="flex gap-2">
              <Button variant="outline" full={false} className="w-28" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button disabled={!name} loading={busy === 'save'} onClick={save}>
                Save account
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NewDues({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  async function create() {
    setError('');
    if (required && !dueDate) return setError('Choose the collection date first.');
    setBusy(true);
    try {
      await api.createDues({ title, amountNaira: Number(amount), dueDate: dueDate || undefined, requiredForCheckIn: required });
      toast('Dues created', 'success', 'Everyone has been told. Reminders go out the evening before and that morning.');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <p className="font-bold">New dues</p>
      <Field label="Title" placeholder="November dues" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Field label="Amount (₦)" inputMode="numeric" placeholder="1000" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      <Field label={required ? 'Collection date' : 'Collection date (optional)'} type="date" min={today} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <Checkbox checked={required} onChange={setRequired} className="rounded-2xl bg-green-light p-4 text-sm text-green">
        <span className="font-bold">Must pay before getting a number</span>
        <span className="block text-xs opacity-80">
          From the collection date, members who haven't paid see a red “Please pay your dues” screen when they scan, until they pay
          online or you mark their cash as paid.
        </span>
      </Checkbox>
      <p className="text-xs text-muted">Members are told now, then reminded automatically the evening before and that morning.</p>
      <ErrorBox>{error}</ErrorBox>
      <div className="flex gap-2">
        <Button variant="outline" full={false} className="w-28" onClick={onDone}>
          Cancel
        </Button>
        <Button loading={busy} disabled={!title || !amount} onClick={create}>
          Create dues
        </Button>
      </div>
    </div>
  );
}

function DuesDetail({ dues }: { dues: Dues }) {
  const me = useMe();
  const members = useGroupMembers(me.groupId);
  const statuses = useDuesStatuses(me.groupId, dues.id);
  const [tab, setTab] = useState<'owing' | 'paid'>('owing');
  const [search, setSearch] = useState('');
  const [batch, setBatch] = useState('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const rows = useMemo(() => {
    const byUid = new Map((statuses ?? []).map((s) => [s.uid, s]));
    const approved = (members ?? []).filter((m) => m.status === 'approved');
    const q = search.trim().toLowerCase().replace(/[\s/-]/g, '');
    return approved
      .map((m) => ({ m, s: byUid.get(m.uid) }))
      .filter((r) => batch === 'all' || r.m.stateCode.split('/')[1] === batch)
      .filter((r) => !q || r.m.fullName.toLowerCase().replace(/\s/g, '').includes(q) || r.m.stateCode.toLowerCase().replace(/[\s/-]/g, '').includes(q));
  }, [members, statuses, search, batch]);

  const batches = useMemo(
    () => [...new Set((members ?? []).filter((m) => m.status === 'approved').map((m) => m.stateCode.split('/')[1]).filter(Boolean))].sort(),
    [members],
  );
  const disputedCount = rows.filter((r) => r.s?.status === 'disputed').length;
  const collection = dues.dueDate
    ? new Date(`${dues.dueDate}T12:00:00`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })
    : null;

  const paid = rows.filter((r) => r.s?.status === 'paid');
  const owing = rows.filter((r) => r.s?.status !== 'paid');
  const collected = paid.reduce((t, r) => t + (r.s?.amountKobo ?? 0), 0);
  const cash = paid.filter((r) => r.s?.method === 'cash').reduce((t, r) => t + (r.s?.amountKobo ?? 0), 0);
  const list = tab === 'owing' ? owing : paid;

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setError('');
    setBusy(label);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <motion.div className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-extrabold">{dues.title}</p>
          <p className="text-sm text-muted">
            {naira(dues.amountKobo)} per member{collection ? ` · collection ${collection}` : ''}
          </p>
          {dues.requiredForCheckIn && <Pill tone="gold">Pay before getting a number</Pill>}
        </div>
        <button
          onClick={() => confirm(`Close "${dues.title}"? Members won't be able to pay it any more.`) && run('close', () => api.closeDues({ duesId: dues.id }), 'Dues closed')}
          className="rounded-xl px-3 py-2 text-sm font-bold text-muted"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat tone="light" value={`${paid.length}/${rows.length}`} label="Paid" />
        <Stat tone="light" value={naira(collected)} label="Collected" />
        <Stat tone="light" value={naira(cash)} label="Of it cash" />
      </div>

      <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-line p-1.5">
        {(['owing', 'paid'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`h-11 rounded-xl text-sm font-bold capitalize ${tab === t ? 'bg-card text-green shadow-card' : 'text-muted'}`}>
            {t} ({t === 'owing' ? owing.length : paid.length})
          </button>
        ))}
      </div>

      <input className="input" placeholder="Search name or state code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
      {batches.length > 1 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {['all', ...batches].map((b) => (
            <button
              key={b}
              onClick={() => setBatch(b)}
              className={`h-9 shrink-0 rounded-full px-4 text-sm font-bold ${batch === b ? 'bg-green text-white' : 'bg-green-light text-green'}`}
            >
              {b === 'all' ? 'All batches' : `Batch ${b}`}
            </button>
          ))}
        </div>
      )}
      {disputedCount > 0 && (
        <p className="rounded-2xl bg-bad-bg px-4 py-3 text-sm font-semibold text-bad">
          {disputedCount} cash {disputedCount === 1 ? 'record was' : 'records were'} reported as wrong by the member. Check with the exco who recorded it.
        </p>
      )}

      <ul className="divide-y divide-line">
        {list.map(({ m, s }) => (
          <li key={m.uid} className="flex items-center gap-3 py-3">
            <Avatar src={m.photoURL} name={m.fullName} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{m.fullName}</p>
              <p className="text-xs text-muted">{m.stateCode}</p>
            </div>
            {s?.status === 'paid' ? (
              <Pill>{s.method === 'cash' ? 'Cash ✓' : 'Online ✓'}</Pill>
            ) : s?.status === 'cash_pending' ? (
              <Pill tone="warn">Awaiting member</Pill>
            ) : (
              <div className="flex items-center gap-2">
                {s?.status === 'disputed' && <Pill tone="bad">Disputed</Pill>}
                <button
                  onClick={() =>
                    confirm(`Mark ${m.fullName} as PAID: ${naira(dues.amountKobo)} cash?\n\nOnly do this after you have received the money. It counts straight away and ${m.fullName.split(' ')[0]} will be told you recorded it.`) &&
                    run(`cash:${m.uid}`, () => api.recordCash({ uid: m.uid, duesId: dues.id }), `${m.fullName.split(' ')[0]} is now paid. They can scan in.`)
                  }
                  disabled={busy === `cash:${m.uid}`}
                  className="flex h-10 items-center gap-1.5 rounded-xl bg-green px-3 text-sm font-bold text-white disabled:opacity-50"
                >
                  <Icon name="cash" size={18} /> Paid (cash)
                </button>
              </div>
            )}
          </li>
        ))}
        {list.length === 0 && <li className="py-4 text-center text-sm text-muted">{tab === 'owing' ? 'Everyone has paid 🎉' : 'No payments yet.'}</li>}
      </ul>

      <ErrorBox>{error}</ErrorBox>
      {owing.length > 0 && (
        <Button
          variant="ghost"
          loading={busy === 'remind'}
          onClick={() => run('remind', () => api.remindDues({ duesId: dues.id }), `Reminder sent to ${owing.length} members`)}
        >
          <Icon name="bell" /> Remind {owing.length} owing
        </Button>
      )}
    </motion.div>
  );
}

export default function DuesAdmin() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const dues = useActiveDues(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  const [creating, setCreating] = useState(false);

  return (
    <>
      <ExcoHeader title="Dues" sub="Online and cash payments" />
      <Page className="space-y-4">
        <PayoutAccount />
        {isMainExco && (creating ? (
          <NewDues onDone={() => setCreating(false)} />
        ) : (
          <Button onClick={() => setCreating(true)}>+ New dues</Button>
        ))}
        {group && !isMainExco && (
          <p className="rounded-2xl bg-line px-4 py-3 text-sm text-muted">
            Only the main exco who created this CDS group can create new dues. You can still manage existing dues here.
          </p>
        )}
        {dues?.map((d) => <DuesDetail key={d.id} dues={d} />)}
        {dues && dues.length === 0 && !creating && (
          <p className="text-center text-sm text-muted">
            {isMainExco ? 'No open dues. Create one above.' : 'No open dues. Ask the main exco to create one.'}
          </p>
        )}
        <p className="text-center text-xs text-muted">
          “Paid (cash)” counts immediately. The member is told who recorded it and can tap “This is wrong”. Every cash record is in the activity log.
        </p>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/GiveNumber.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Icon, Page, Pill } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Profile } from '../../lib/types';

/**
 * Main exco only: give a registered member the next number when their phone is off / dead.
 * Search, tap the person, confirm. The door code changes straight after.
 */
export default function GiveNumber() {
  const { me, group, open, attendees } = useExcoDay();
  const members = useGroupMembers(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [given, setGiven] = useState<{ name: string; number: number } | null>(null);

  const byUid = useMemo(() => new Map((attendees ?? []).map((a) => [a.uid, a])), [attendees]);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/[\s/-]/g, '');
    if (!q) return [];
    return (members ?? [])
      .filter((m) => m.status === 'approved')
      .filter((m) => m.fullName.toLowerCase().replace(/\s/g, '').includes(q) || m.stateCode.toLowerCase().replace(/[\s/-]/g, '').includes(q))
      .slice(0, 20);
  }, [members, search]);

  async function give() {
    if (!picked) return;
    setError('');
    setBusy(true);
    try {
      const r = await api.giveNextNumber({ uid: picked.uid });
      navigator.vibrate?.([60, 40, 60]);
      setGiven({ name: picked.fullName, number: r.number });
      toast(r.already ? `${picked.fullName} already has No. ${r.number}` : `${picked.fullName} is No. ${r.number}`, 'success', 'The door code has changed.');
      setPicked(null);
      setSearch('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ExcoHeader title="Give a number" sub="For registered members whose phone is off" />
      <Page className="space-y-4">
        {group && !isMainExco ? (
          <div className="card text-center text-sm text-muted">Only the main exco can give numbers by hand.</div>
        ) : !open ? (
          <div className="card text-center">
            <p className="font-bold">Today's meeting is not open</p>
            <Link to="/exco" className="mt-3 inline-block font-bold text-green">
              Open it from Today →
            </Link>
          </div>
        ) : (
          <>
            <AnimatePresence>
              {given && (
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="number-card rounded-[28px] p-5 text-center text-white"
                >
                  <p className="text-sm text-green-mid">{given.name}</p>
                  <p className="font-display text-7xl font-extrabold">{given.number}</p>
                  <p className="text-xs text-green-mid">Tell them their number. The door code has changed.</p>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="card space-y-3">
              <input
                className="input"
                autoFocus
                placeholder="Search name or state code"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPicked(null);
                  setGiven(null);
                }}
                aria-label="Search members"
              />
              {!search && <p className="text-sm text-muted">Type a name or state code (e.g. 26B/1142) to find the person.</p>}
              {search && members === undefined && <div className="h-14 animate-pulse rounded-2xl bg-line" />}
              {search && members && list.length === 0 && <p className="text-sm text-muted">No approved member matches.</p>}
              <ul className="divide-y divide-line">
                {list.map((m) => {
                  const a = byUid.get(m.uid);
                  return (
                    <li key={m.uid}>
                      <button
                        onClick={() => setPicked(m)}
                        className={`flex w-full items-center gap-3 rounded-2xl px-2 py-3 text-left ${picked?.uid === m.uid ? 'bg-green-light' : ''}`}
                      >
                        <Avatar src={m.photoURL} name={m.fullName} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold">{m.fullName}</p>
                          <p className="text-xs text-muted">{m.stateCode}</p>
                        </div>
                        {a ? <Pill>No. {tagLabel(a)}</Pill> : <Pill tone="muted">No number</Pill>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <AnimatePresence>
              {picked && (
                <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} className="card space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar src={picked.photoURL} name={picked.fullName} size={64} />
                    <div className="min-w-0">
                      <p className="font-display text-lg font-extrabold">{picked.fullName}</p>
                      <p className="text-sm text-muted">{picked.stateCode}</p>
                    </div>
                  </div>
                  <p className="rounded-2xl bg-gold-bg px-4 py-3 text-sm text-gold-text">Check their NYSC ID card matches this photo before you give a number.</p>
                  <ErrorBox>{error}</ErrorBox>
                  {byUid.get(picked.uid) ? (
                    <p className="text-center font-bold text-green">Already has No. {tagLabel(byUid.get(picked.uid)!)}</p>
                  ) : (
                    <Button loading={busy} onClick={give}>
                      <Icon name="check" /> Give next number
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/Members.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { MemberCard } from '../../components/MemberCard';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Icon, Page, Pill, Select } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Profile } from '../../lib/types';

type Filter = 'pending' | 'approved' | 'excos';
type Sort = 'name' | 'newest' | 'code';

/** "LA/26B/1142" → "26B" (the NYSC batch). */
const batchOf = (stateCode: string) => stateCode.split('/')[1] ?? '';
const timeOf = (m: Profile) => {
  const t = (m as unknown as { createdAt?: { toMillis?: () => number } }).createdAt;
  return typeof t?.toMillis === 'function' ? t.toMillis() : 0;
};

export default function Members() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const members = useGroupMembers(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [batch, setBatch] = useState<string>('all');
  const [noPhotoOnly, setNoPhotoOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('name');
  const [selected, setSelected] = useState<Profile | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const counts = useMemo(
    () => ({
      pending: members?.filter((m) => m.status === 'pending').length ?? 0,
      approved: members?.filter((m) => m.status === 'approved').length ?? 0,
      excos: members?.filter((m) => m.role === 'exco').length ?? 0,
    }),
    [members],
  );

  // Members in the current tab, before the batch / photo filters (used for the chip counts).
  const inTab = useMemo(
    () =>
      (members ?? []).filter((m) =>
        filter === 'pending' ? m.status === 'pending' : filter === 'excos' ? m.role === 'exco' : m.status === 'approved',
      ),
    [members, filter],
  );

  // Batches that actually exist in this tab, e.g. [["26A", 12], ["26B", 30]].
  const batches = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of inTab) {
      const b = batchOf(m.stateCode);
      if (b) c.set(b, (c.get(b) ?? 0) + 1);
    }
    return [...c.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [inTab]);

  const list = useMemo(() => {
    // Search ignores slashes and spaces, so "26b1142", "26B/1142" and "1142" all find LA/26B/1142.
    const q = search.trim().toLowerCase().replace(/[\s/-]/g, '');
    const rows = inTab
      .filter((m) => batch === 'all' || batchOf(m.stateCode) === batch)
      .filter((m) => !noPhotoOnly || !m.photoURL)
      .filter(
        (m) =>
          !q ||
          m.fullName.toLowerCase().replace(/\s/g, '').includes(q) ||
          m.stateCode.toLowerCase().replace(/[\s/-]/g, '').includes(q) ||
          (m.phone ?? '').replace(/\D/g, '').includes(q.replace(/^0/, '')),
      );
    return [...rows].sort((a, b) =>
      sort === 'newest' ? timeOf(b) - timeOf(a) : sort === 'code' ? a.stateCode.localeCompare(b.stateCode, undefined, { numeric: true }) : a.fullName.localeCompare(b.fullName),
    );
  }, [inTab, batch, noPhotoOnly, search, sort]);

  const filtersOn = batch !== 'all' || noPhotoOnly || search.trim() !== '';

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setError('');
    setBusy(label);
    try {
      await fn();
      toast(done, 'success', selected?.fullName);
      setSelected(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  function resetPin() {
    if (!selected) return;
    const pin = prompt(`New 6-digit PIN for ${selected.fullName}:\n(Only after checking their NYSC ID card)`);
    if (pin == null) return;
    if (!/^\d{6}$/.test(pin)) return setError('The PIN must be 6 digits.');
    void run('pin', () => api.resetPin({ uid: selected.uid, pin }), 'PIN reset. Tell them their new PIN privately.');
  }

  return (
    <>
      <ExcoHeader title="Members" sub={`${counts.approved} approved · ${counts.pending} waiting`}>
        <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/10 p-1">
          {(['pending', 'approved', 'excos'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`relative h-11 rounded-xl text-sm font-bold capitalize ${filter === f ? 'text-brand' : 'text-white'}`}>
              {filter === f && <motion.span layoutId="mem-tab" className="absolute inset-0 rounded-xl bg-white" />}
              <span className="relative">
                {f === 'pending' ? 'To approve' : f} ({counts[f]})
              </span>
            </button>
          ))}
        </div>
      </ExcoHeader>

      <Page className="space-y-4">
        <AnimatePresence mode="wait">
          {selected ? (
            <motion.div key="sel">
              <MemberCard
                member={selected}
                tone={selected.status === 'pending' ? 'warn' : 'neutral'}
                headline={selected.status === 'pending' ? 'Check their NYSC ID card' : selected.role === 'exco' ? 'Exco' : 'Member'}
                detail={selected.status === 'pending' ? 'Name, state code and face must match the card.' : selected.phone}
              >
                {selected.status === 'pending' && (
                  <>
                    <Button loading={busy === 'approve'} onClick={() => run('approve', () => api.approveMember({ uid: selected.uid, approve: true }), 'Approved')}>
                      <Icon name="check" /> Approve
                    </Button>
                    <Button variant="danger" loading={busy === 'reject'} onClick={() => run('reject', () => api.approveMember({ uid: selected.uid, approve: false }), 'Rejected')}>
                      <Icon name="x" /> Reject
                    </Button>
                  </>
                )}
                {selected.status === 'approved' && selected.uid !== me.uid && isMainExco && (
                  <Button
                    variant="outline"
                    loading={busy === 'role'}
                    onClick={() =>
                      run(
                        'role',
                        () => api.setRole({ uid: selected.uid, role: selected.role === 'exco' ? 'member' : 'exco' }),
                        selected.role === 'exco' ? 'Removed as exco' : 'Made exco',
                      )
                    }
                  >
                    {selected.role === 'exco' ? 'Remove as exco' : 'Make exco'}
                  </Button>
                )}
                {selected.status === 'approved' && selected.uid !== me.uid && group && !isMainExco && (
                  <p className="rounded-xl bg-line px-3 py-2 text-sm text-muted">
                    Only the main exco who created this CDS group can change exco roles.
                  </p>
                )}
                {selected.status === 'approved' && (
                  <Button variant="ghost" loading={busy === 'pin'} onClick={resetPin}>
                    Reset PIN
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setSelected(null)}>
                  Back to list
                </Button>
              </MemberCard>
            </motion.div>
          ) : scanning ? (
            <motion.div key="scan" className="space-y-3">
              <QRScan
                className="aspect-square w-full"
                onResult={(t) => {
                  const q = parseQR(t);
                  const m = q?.type === 'member' ? members?.find((x) => x.uid === q.uid) : undefined;
                  if (m) {
                    setSelected(m);
                    setScanning(false);
                  } else setError('That code is not a member of your CDS group.');
                }}
              />
              <Button variant="outline" onClick={() => setScanning(false)}>
                Close camera
              </Button>
            </motion.div>
          ) : (
            <motion.div key="list" className="space-y-3">
              <div className="flex gap-2">
                <input className="input flex-1" placeholder="Search name, state code or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
                <button onClick={() => setScanning(true)} aria-label="Scan member code" className="grid h-14 w-14 place-items-center rounded-2xl bg-green text-white">
                  <Icon name="scan" />
                </button>
              </div>

              {/* Batch chips (26A, 26B, 26C …), no-photo filter and sort */}
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                {[['all', inTab.length] as [string, number], ...batches].map(([b, n]) => (
                  <button
                    key={b}
                    onClick={() => setBatch(b)}
                    className={`relative h-10 shrink-0 rounded-full px-4 text-sm font-bold transition-colors ${
                      batch === b ? 'text-white' : 'bg-card text-ink shadow-card'
                    }`}
                  >
                    {batch === b && <motion.span layoutId="batch-chip" className="absolute inset-0 rounded-full bg-green" />}
                    <span className="relative">
                      {b === 'all' ? 'All batches' : `Batch ${b}`} <span className="opacity-70">{n}</span>
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => setNoPhotoOnly((v) => !v)}
                  className={`h-10 shrink-0 rounded-full px-4 text-sm font-bold ${noPhotoOnly ? 'bg-warn text-white' : 'bg-card text-warn shadow-card'}`}
                >
                  No photo
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted">
                  {list.length} {list.length === 1 ? 'person' : 'people'}
                  {filtersOn && (
                    <button
                      onClick={() => {
                        setBatch('all');
                        setNoPhotoOnly(false);
                        setSearch('');
                      }}
                      className="ml-2 font-bold text-green"
                    >
                      Clear filters
                    </button>
                  )}
                </span>
                <Select<Sort>
                  size="sm"
                  className="w-40"
                  value={sort}
                  onChange={setSort}
                  options={[
                    { value: 'name', label: 'Name A–Z' },
                    { value: 'code', label: 'State code' },
                    { value: 'newest', label: 'Newest first' },
                  ]}
                />
              </div>

              {members === undefined ? (
                <div className="card h-40 animate-pulse" />
              ) : list.length === 0 ? (
                <div className="card text-center text-sm text-muted">
                  {filtersOn ? 'Nobody matches these filters.' : filter === 'pending' ? 'Nobody is waiting for approval.' : 'No members here yet.'}
                </div>
              ) : (
                <ul className="card divide-y divide-line !p-0">
                  {list.map((m) => (
                    <li key={m.uid}>
                      <button onClick={() => setSelected(m)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                        <Avatar src={m.photoURL} name={m.fullName} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-bold">{m.fullName}</p>
                          <p className="text-xs text-muted">
                            {m.stateCode}
                            {!m.photoURL && <span className="font-bold text-warn"> · No photo yet</span>}
                          </p>
                        </div>
                        {m.role === 'exco' && <Pill>Exco</Pill>}
                        {m.status === 'pending' && <Pill tone="warn">Pending</Pill>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <Link to="/exco/cards" className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-card font-bold text-green shadow-card">
                <Icon name="print" /> Print QR cards (for members without smartphones)
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
        <ErrorBox>{error}</ErrorBox>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/Messages.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Field, Icon, Page, Pill, Select } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { toast } from '../../lib/toast';

type Audience = 'all' | 'unpaid' | 'pending' | 'excos';

const TEMPLATES: { emoji: string; label: string; title: string; body: string; link: string; audience?: Audience }[] = [
  { emoji: '☀️', label: 'Good morning', title: 'Good morning corpers ☀️', body: 'Have a great day. See you at CDS!', link: '/home' },
  { emoji: '💼', label: 'Job alert', title: 'Job alert 💼', body: 'A new opportunity is available. Ask the excos for details.', link: '/home' },
  { emoji: '💰', label: 'Dues reminder', title: 'Dues reminder 💰', body: 'Please pay your CDS dues in the app before the next meeting.', link: '/dues', audience: 'unpaid' },
  { emoji: '📍', label: 'Venue change', title: 'Venue change 📍', body: 'This week’s CDS meeting holds at a new venue: ', link: '/home' },
  { emoji: '⚠️', label: 'Meeting cancelled', title: 'CDS meeting cancelled ⚠️', body: 'There will be no CDS meeting this week. More details soon.', link: '/home' },
];

const AUDIENCES: { value: Audience; label: string; hint: string }[] = [
  { value: 'all', label: 'Everyone (approved members)', hint: 'All approved corpers in this CDS' },
  { value: 'unpaid', label: 'Haven’t paid dues', hint: 'Members who still owe any open dues' },
  { value: 'pending', label: 'Waiting for approval', hint: 'People who signed up but aren’t approved yet' },
  { value: 'excos', label: 'Excos only', hint: 'Just the excos' },
];

const LINKS = [
  { value: '/home', label: 'Home' },
  { value: '/dues', label: 'Dues' },
  { value: '/tag', label: 'My tag' },
  { value: '/scan', label: 'Scan in' },
];

type Sent = Awaited<ReturnType<typeof api.listGroupMessages>>['messages'][number];

/** Main exco: send a custom push message to members ("Good morning corpers", "Job alert" …). */
export default function Messages() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>('all');
  const [link, setLink] = useState('/home');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Sent[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listGroupMessages({});
      setHistory(r.messages);
      setLeft(r.left);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (isMainExco) void load();
  }, [isMainExco, load]);

  async function send() {
    setError('');
    if (title.trim().length < 3 || body.trim().length < 3) return setError('Write a title and a message.');
    const who = AUDIENCES.find((a) => a.value === audience)!.label.toLowerCase();
    if (!confirm(`Send "${title.trim()}" to ${who}?`)) return;
    setBusy(true);
    try {
      const r = await api.sendGroupMessage({ title: title.trim(), body: body.trim(), audience, link });
      toast(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}`, 'success', `${r.left} message${r.left === 1 ? '' : 's'} left today.`);
      setTitle('');
      setBody('');
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (group && !isMainExco) {
    return (
      <>
        <ExcoHeader title="Send a message" />
        <Page>
          <div className="card text-center text-sm text-muted">Only the main exco can send messages to members.</div>
        </Page>
      </>
    );
  }

  return (
    <>
      <ExcoHeader title="Send a message" sub={left === null ? 'Push notification to members' : `${left} of 5 left today`} />
      <Page className="space-y-4">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              onClick={() => {
                setTitle(t.title);
                setBody(t.body);
                setLink(t.link);
                if (t.audience) setAudience(t.audience);
              }}
              className="h-10 shrink-0 rounded-full bg-card px-4 text-sm font-bold text-green shadow-card active:scale-95"
            >
              {t.emoji} {t.label}
            </button>
          ))}
        </div>

        <div className="card space-y-4">
          <Field label="Title" maxLength={60} placeholder="Good morning corpers" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div>
            <label htmlFor="msg-body" className="label">
              Message
            </label>
            <textarea
              id="msg-body"
              maxLength={300}
              rows={4}
              placeholder="Write your message…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="input !h-auto resize-none py-3"
            />
            <p className="mt-1 text-right text-xs text-muted">{body.length}/300</p>
          </div>
          <Select<Audience>
            label="Send to"
            value={audience}
            onChange={setAudience}
            options={AUDIENCES.map((a) => ({ value: a.value, label: a.label, hint: a.hint }))}
          />
          <Select label="When they tap it, open" value={link} onChange={setLink} options={LINKS} />

          {/* Preview of how it looks on a phone */}
          <AnimatePresence>
            {(title || body) && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-2xl bg-line p-3">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">Preview</p>
                <div className="flex gap-3 rounded-2xl bg-card p-3 shadow-card">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-green text-xs font-extrabold text-white">CDS</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{title || 'Title'}</p>
                    <p className="line-clamp-3 text-sm text-muted">{body || 'Message'}</p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <ErrorBox>{error}</ErrorBox>
          <Button loading={busy} disabled={left === 0} onClick={send}>
            <Icon name="bell" /> Send message
          </Button>
          <p className="text-center text-xs text-muted">Up to 5 messages a day, so members don’t turn notifications off. Only members with alerts on receive it.</p>
        </div>

        <div className="card !p-0">
          <p className="px-5 pb-2 pt-4 font-bold">Sent messages</p>
          {history === null ? (
            <div className="mx-5 mb-4 h-14 animate-pulse rounded-2xl bg-line" />
          ) : history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {history.map((m) => (
                <li key={m.id} className="space-y-1 px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold">{m.title}</p>
                    <Pill tone="muted">{m.recipients} people</Pill>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted">{m.body}</p>
                  <p className="text-xs text-muted">
                    {m.sentByName} ·{' '}
                    {m.sentAt ? new Date(m.sentAt).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/PrintCards.tsx`

```tsx
import { QRCodeSVG } from 'qrcode.react';
import { useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useGroupMembers } from '../../hooks/useLive';
import { memberQR } from '../../lib/rules';

/** Printable QR cards for members without smartphones. Print → cut → laminate. */
export default function PrintCards() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const members = useGroupMembers(me.groupId);
  const [search, setSearch] = useState('');

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (members ?? []).filter(
      (m) => m.status === 'approved' && (!q || m.fullName.toLowerCase().includes(q) || m.stateCode.toLowerCase().includes(q)),
    );
  }, [members, search]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print">
        <TopBar title="Print member cards" back="/exco/members" sub="Search to print only the people who need one" />
        <div className="flex gap-3 p-4">
          <input className="input flex-1" placeholder="Search name or state code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
          <Button full={false} onClick={() => window.print()}>
            Print {list.length}
          </Button>
        </div>
      </div>

      <div className="print-grid grid gap-4 p-4 sm:grid-cols-2">
        {list.map((m) => (
          <div key={m.uid} className="print-card theme-light flex items-center gap-4 rounded-3xl bg-white p-4 text-ink shadow-card">
            <div className="flex-1">
              <p className="text-[10px] font-extrabold tracking-widest text-green">CDS PASS · {group?.name}</p>
              <div className="mt-2 flex items-center gap-2">
                <Avatar src={m.photoURL} name={m.fullName} size={40} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold">{m.fullName}</p>
                  <p className="text-xs font-semibold text-muted">{m.stateCode}</p>
                </div>
              </div>
              <p className="mt-3 text-[10px] text-muted">Show this card at the door and at the thumbprint table.</p>
            </div>
            <QRCodeSVG value={memberQR(m.uid)} size={110} level="M" fgColor="#03301A" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

### `web/src/pages/exco/Settings.tsx`

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Button, ErrorBox, Field, Icon, Page, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useLogs } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { getPosition } from '../../lib/device';
import { errorText } from '../../lib/firebase';
import { toast } from '../../lib/toast';
import { normalizeStateCode } from '../../lib/rules';
import { PLATFORM_ADMIN_STATE_CODE } from '../../lib/appConfig';

const actionText: Record<string, string> = {
  group_created: 'Created the group',
  member_registered: 'Signed up',
  member_approved: 'Approved a member',
  member_rejected: 'Rejected a member',
  role_changed: 'Changed a role',
  pin_reset: 'Reset a PIN',
  settings_changed: 'Changed settings',
  session_opened: 'Opened the meeting',
  session_closed: 'Closed the meeting',
  notification_test: 'Tested push notifications',
  manual_checkin: 'Manual check-in',
  priority_given: 'Gave a priority tag',
  batch_called: 'Called a batch',
  table_refused: 'Refused at table',
  thumbprinted: 'Marked thumbprinted',
  payout_account_set: 'Set dues account',
  dues_created: 'Created dues',
  dues_closed: 'Closed dues',
  cash_recorded: 'Recorded cash',
  cash_confirmed: 'Member confirmed cash',
  cash_disputed: 'Member disputed cash',
  dues_reminder: 'Sent dues reminder',
};

export default function Settings() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const logs = useLogs(me.groupId, 40);
  const [size, setSize] = useState('');
  const [radius, setRadius] = useState('300');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [newGroup, setNewGroup] = useState({ name: '', lga: '', state: '', mainExcoStateCode: '' });
  const [createdGroup, setCreatedGroup] = useState<{ joinCode: string; mainExcoStateCode: string } | null>(null);

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setError('');
    setBusy(label);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function setVenueHere() {
    setBusy('venue');
    const pos = await getPosition(12000);
    setBusy('');
    if (!pos) return setError('Could not get your location. Turn on location and try again.');
    await run('venue', () => api.updateGroupSettings({ venue: { ...pos, radiusM: Number(radius) || 300 } }), 'Venue saved. Members must be within range to scan in.');
  }

  async function testNotification() {
    setError('');
    setBusy('notification');
    try {
      const result = await api.testNotification({});
      if (!result.registered) {
        setError(`No approved members have alerts registered yet (${result.members} members in the group). Members need to turn on alerts in their Profile.`);
      } else if (!result.sent) {
        setError(`Firebase delivered 0 of ${result.registered} registered member devices. Members should re-enable alerts; check the server logs if this continues.`);
      } else {
        toast('Test notification sent', 'success', `${result.sent} devices notified across ${result.members} approved members.`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function createGroup() {
    setError('');
    const mainExcoStateCode = normalizeStateCode(newGroup.mainExcoStateCode);
    if (!mainExcoStateCode) return setError('Enter a valid state code for the new group’s main exco.');
    setBusy('create-group');
    try {
      const result = await api.createManagedGroup({
        group: { name: newGroup.name, lga: newGroup.lga, state: newGroup.state },
        mainExcoStateCode,
      });
      setCreatedGroup({ joinCode: result.joinCode, mainExcoStateCode: result.mainExcoStateCode });
      setNewGroup({ name: '', lga: '', state: '', mainExcoStateCode: '' });
      toast('CDS group created', 'success', `Share code ${result.joinCode} with the appointed main exco.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <TopBar title="Group settings" back="/exco" sub={group?.name} />
      <Page className="space-y-4">
        <div className="card space-y-2 text-center">
          <p className="text-sm font-semibold text-muted">Group code for new members</p>
          <p className="text-4xl font-extrabold tracking-[0.3em] text-green">{group?.joinCode ?? '……'}</p>
          <Button
            variant="ghost"
            onClick={() => {
              const text = `Join our CDS group on CDS Pass: open ${location.origin} and use group code ${group?.joinCode}`;
              if (navigator.share) void navigator.share({ text }).catch(() => undefined);
              else void navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success'));
            }}
          >
            Share with members
          </Button>
        </div>

        <div className="card space-y-3">
          <Field
            label={`Batch size (now ${group?.batchSize ?? 20})`}
            inputMode="numeric"
            placeholder="20"
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))}
          />
          <Button loading={busy === 'size'} disabled={!size} onClick={() => run('size', () => api.updateGroupSettings({ batchSize: Number(size) }), 'Batch size saved')}>
            Save batch size
          </Button>
        </div>

        <div className="card space-y-3">
          <p className="font-bold">Venue location check</p>
          <p className="text-sm text-muted">
            {group?.venue
              ? `On: members must be within ${group.venue.radiusM} m of the venue to scan in.`
              : 'Off. Stand at the CDS venue and tap the button to turn it on.'}
          </p>
          <Field label="Allowed distance (metres)" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ''))} />
          <Button loading={busy === 'venue'} onClick={setVenueHere}>
            Use my current location as the venue
          </Button>
          {group?.venue && (
            <Button variant="outline" loading={busy === 'clear'} onClick={() => run('clear', () => api.updateGroupSettings({ clearVenue: true }), 'Location check turned off')}>
              Turn off location check
            </Button>
          )}
        </div>

        <div className="card">
          <ThemeToggle />
        </div>

        <div className="card space-y-3">
          <p className="font-bold">Main exco tools</p>
          {(group?.mainExcoUid ?? group?.createdBy) === me.uid ? (
            <>
              <Link to="/exco/messages" className="flex items-center gap-3 rounded-2xl bg-gold-bg p-4 text-gold-text">
                <Icon name="bell" />
                <span className="flex-1">
                  <span className="block font-bold">Send a message</span>
                  <span className="block text-xs opacity-80">Good morning, job alerts, dues reminders… to everyone or a chosen group</span>
                </span>
                →
              </Link>
              <Link to="/exco/give-number" className="flex items-center gap-3 rounded-2xl bg-green-light p-4 text-green">
                <Icon name="users" />
                <span className="flex-1">
                  <span className="block font-bold">Give a number</span>
                  <span className="block text-xs opacity-80">For a registered member whose phone is off. The door code changes after.</span>
                </span>
                →
              </Link>
              <Button variant="ghost" loading={busy === 'notification'} onClick={testNotification}>
                Send a test notification
              </Button>
            </>
          ) : (
            <p className="text-sm font-semibold text-muted">Only the main exco can send messages and give numbers by hand.</p>
          )}
        </div>

        {me.stateCode === PLATFORM_ADMIN_STATE_CODE && (
          <div className="card space-y-3">
            <p className="font-bold">Create another CDS group</p>
            <p className="text-sm text-muted">Choose the member who will own this group as its main exco. Your current group membership will stay as it is.</p>
            <Field label="New CDS group name" placeholder="Digital Skills CDS" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
            <Field label="LGA" placeholder="Ikorodu" value={newGroup.lga} onChange={(e) => setNewGroup({ ...newGroup, lga: e.target.value })} />
            <Field label="State" placeholder="Lagos" value={newGroup.state} onChange={(e) => setNewGroup({ ...newGroup, state: e.target.value })} />
            <Field
              label="Main exco state code"
              placeholder="LA/26B/1142"
              autoCapitalize="characters"
              value={newGroup.mainExcoStateCode}
              onChange={(e) => setNewGroup({ ...newGroup, mainExcoStateCode: e.target.value })}
            />
            <Button loading={busy === 'create-group'} onClick={createGroup}>Create CDS group</Button>
            {createdGroup && (
              <div className="rounded-2xl bg-green-light p-4 text-center">
                <p className="text-sm font-semibold text-muted">Give this group code to {createdGroup.mainExcoStateCode}</p>
                <p className="my-2 text-3xl font-extrabold tracking-[0.3em] text-green">{createdGroup.joinCode}</p>
                <p className="text-xs text-muted">They join with this code and their state code. CDS Pass will make them the approved main exco automatically.</p>
                <Button
                  className="mt-3"
                  variant="ghost"
                  onClick={() => {
                    const text = `You are the main exco for a CDS Pass group. Open ${location.origin}, sign up with state code ${createdGroup.mainExcoStateCode}, and join using group code ${createdGroup.joinCode}.`;
                    if (navigator.share) void navigator.share({ text }).catch(() => undefined);
                    else void navigator.clipboard?.writeText(text).then(() => toast('Instructions copied', 'success'));
                  }}
                >
                  Share setup instructions
                </Button>
              </div>
            )}
          </div>
        )}

        <ErrorBox>{error}</ErrorBox>

        <div className="card !p-0">
          <p className="px-5 pb-2 pt-4 font-bold">Activity log</p>
          <p className="px-5 pb-3 text-xs text-muted">Every exco action is recorded here. Nobody can edit or delete it.</p>
          <ul className="divide-y divide-line">
            {(logs ?? []).map((l) => (
              <li key={l.id} className="px-5 py-3 text-sm">
                <p className="font-semibold">
                  {actionText[l.action] ?? l.action}
                  {typeof l.label === 'string' ? ` · ${l.label}` : ''}
                  {l.stateCode ? ` · ${l.stateCode}` : ''}
                  {typeof l.reason === 'string' ? ` · ${String(l.reason).replace(/_/g, ' ')}` : ''}
                </p>
                <p className="text-xs text-muted">{l.atMs ? new Date(l.atMs).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable'}</p>
              </li>
            ))}
          </ul>
        </div>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/exco/Table.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { ExcoHeader } from '../../components/ExcoHeader';
import { MemberCard } from '../../components/MemberCard';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Field, Icon, Page } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel, parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { TableCheckResponse } from '../../lib/types';

function verdict(r: TableCheckResponse) {
  const tag = r.priority && r.pNumber ? `P${r.pNumber}` : `No. ${r.number}`;
  switch (r.result) {
    case 'your_turn':
      return { tone: 'ok' as const, headline: `${tag} · Your turn ✓`, detail: 'Check the ID card, then the LGI thumbprints.' };
    case 'not_turn':
      return { tone: 'bad' as const, headline: `${tag} · Not your turn`, detail: `Now calling ${batchLabel(r.batch)}. Please wait.` };
    case 'already_done':
      return {
        tone: 'bad' as const,
        headline: 'Already thumbprinted',
        detail: r.doneAt ? `Done at ${new Date(r.doneAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}. This tag is used up.` : 'This tag is used up.',
      };
    case 'not_checked_in':
      return { tone: 'bad' as const, headline: 'Not checked in today', detail: 'They must check in at the door first.' };
    case 'not_started':
      return { tone: 'warn' as const, headline: `${tag} · Not started`, detail: 'Call priority or the first batch first.' };
  }
}

export default function Table() {
  const { session, stats, open } = useExcoDay();
  const [result, setResult] = useState<TableCheckResponse | null>(null);
  const [manual, setManual] = useState(false);
  const [stateCode, setStateCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function check(who: { uid?: string; stateCode?: string }) {
    setError('');
    setBusy('check');
    try {
      const r = await api.tableCheck(who);
      navigator.vibrate?.(r.result === 'your_turn' ? 80 : [200, 80, 200]);
      setResult(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function done() {
    if (!result) return;
    setBusy('done');
    try {
      await api.markDone({ uid: result.member.uid });
      toast('Thumbprinted ✓', 'success', result.member.fullName);
      setResult(null);
      setStateCode('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  const v = result ? verdict(result) : null;

  return (
    <>
      <ExcoHeader title="Thumbprint table" sub={`Now calling ${batchLabel(session?.batch)} · ${stats.done} done`} />
      <Page className="space-y-4">
        {!open && <ErrorBox>Today's meeting is not open.</ErrorBox>}

        <AnimatePresence mode="wait">
          {result && v ? (
            <motion.div key="result" className="space-y-3">
              <MemberCard member={result.member} tone={v.tone} headline={v.headline} detail={v.detail}>
                {result.result === 'your_turn' ? (
                  <>
                    <Button variant="light" loading={busy === 'done'} onClick={done}>
                      <Icon name="check" /> Thumbprinted: Done
                    </Button>
                    <Button variant="ghost" className="!bg-white/15 !text-white" onClick={() => setResult(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button variant="light" onClick={() => setResult(null)}>
                    Next person
                  </Button>
                )}
              </MemberCard>
            </motion.div>
          ) : manual ? (
            <motion.div key="manual" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="card space-y-4">
              <Field label="State code (phone dead / no tag)" placeholder="LA/26B/1142" autoCapitalize="characters" value={stateCode} onChange={(e) => setStateCode(e.target.value)} />
              <Button loading={busy === 'check'} onClick={() => check({ stateCode })}>
                Check turn
              </Button>
            </motion.div>
          ) : (
            <motion.div key="scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <QRScan
                className="aspect-square w-full shadow-lift"
                paused={!!busy || !!result}
                onResult={(t) => {
                  const q = parseQR(t);
                  if (q?.type === 'member') void check({ uid: q.uid });
                  else setError('Scan the member’s CDS Pass tag or printed card.');
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <ErrorBox>{error}</ErrorBox>

        {!result && (
          <button
            onClick={() => {
              setManual((m) => !m);
              setError('');
            }}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-card font-bold text-green shadow-card"
          >
            <Icon name={manual ? 'camera' : 'keypad'} />
            {manual ? 'Scan a tag instead' : 'No tag? Use state code'}
          </button>
        )}
      </Page>
    </>
  );
}
```

---

### `web/src/pages/member/Dues.tsx`

```tsx
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ErrorBox, Icon, Page, Pill, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useActiveDues, useDoc, useGroup, useMyPayments } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { duesCharges, naira } from '../../lib/money';
import { toast } from '../../lib/toast';
import type { Dues as DuesItem, DuesStatus } from '../../lib/types';


function DuesCard({ dues, hasAccount }: { dues: DuesItem; hasAccount: boolean }) {
  const me = useMe();
  const status = useDoc<DuesStatus>(`groups/${me.groupId}/dues/${dues.id}/status/${me.uid}`);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const paid = status?.status === 'paid';
  const cashPending = status?.status === 'cash_pending';
  const disputed = status?.status === 'disputed';
  const collection = dues.dueDate
    ? new Date(`${dues.dueDate}T12:00:00`).toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'short' })
    : null;

  async function pay() {
    setError('');
    setBusy('pay');
    try {
      const r = await api.startPayment({ duesId: dues.id, returnUrl: window.location.origin });
      window.location.href = r.authorizationUrl; // Paystack checkout: card, transfer or USSD
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  }

  async function respond(confirm: boolean) {
    setError('');
    setBusy(confirm ? 'yes' : 'no');
    try {
      await api.respondCash({ duesId: dues.id, confirm });
      toast(confirm ? 'Cash payment confirmed' : 'Reported to your main exco', confirm ? 'success' : 'info');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <motion.div className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-extrabold">{dues.title}</p>
          {collection && <p className="text-sm text-muted">Collection on {collection}</p>}
          {dues.requiredForCheckIn && !paid && (
            <p className="mt-1 inline-flex rounded-full bg-bad-bg px-2.5 py-1 text-xs font-bold text-bad">Pay before you can get a number</p>
          )}
        </div>
        <p className="text-2xl font-extrabold text-green">{naira(dues.amountKobo)}</p>
      </div>

      {status === undefined ? (
        <div className="h-14 animate-pulse rounded-2xl bg-line" />
      ) : paid ? (
        <div className="flex items-center gap-3 rounded-2xl bg-green-light p-4 text-green">
          <Icon name="check" />
          <div>
            <p className="font-extrabold">Paid</p>
            <p className="text-xs">
              {status.method === 'cash' ? `Cash, recorded by ${status.recordedByName ?? 'an exco'}` : 'Online'} ·{' '}
              {(status.paidAt ?? status.recordedAt)?.toDate().toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
            </p>
          </div>
          {status.method === 'cash' && (
            <button
              disabled={busy === 'no'}
              onClick={() =>
                confirm(`Report that you did NOT pay this ${naira(status.amountKobo)} cash? Your main exco will be told.`) && respond(false)
              }
              className="ml-auto rounded-xl px-2 py-1 text-xs font-bold text-bad underline disabled:opacity-50"
            >
              This is wrong
            </button>
          )}
        </div>
      ) : disputed ? (
        <div className="rounded-2xl bg-bad-bg p-4 text-sm text-bad">
          <p className="font-bold">You reported a cash record as wrong.</p>
          <p>Your main exco has been told and will sort it out. Until then this counts as not paid.</p>
          <Button className="mt-3" loading={busy === 'pay'} disabled={!hasAccount} onClick={pay}>
            <Icon name="card" /> Pay {naira(duesCharges(dues.amountKobo).totalKobo)} online
          </Button>
        </div>
      ) : cashPending ? (
        <div className="space-y-3 rounded-2xl bg-warn-bg p-4 text-warn">
          <p className="font-bold">
            {status.recordedByName ?? 'An exco'} recorded {naira(status.amountKobo)} cash from you. Is that correct?
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button loading={busy === 'yes'} onClick={() => respond(true)}>
              Yes, I paid
            </Button>
            <Button variant="outline" loading={busy === 'no'} onClick={() => respond(false)}>
              No, I didn't
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Button loading={busy === 'pay'} disabled={!hasAccount} onClick={pay}>
            <Icon name="card" /> Pay {naira(duesCharges(dues.amountKobo).totalKobo)}
          </Button>
          <p className="text-center text-xs text-muted">
            {naira(dues.amountKobo)} dues + {naira(duesCharges(dues.amountKobo).serviceKobo)} service fee + {naira(duesCharges(dues.amountKobo).paystackKobo)} Paystack charge · card, transfer or USSD
          </p>
          {!hasAccount && <p className="text-center text-xs font-semibold text-warn">Your excos haven't added the CDS bank account yet.</p>}
        </div>
      )}
      <ErrorBox>{error}</ErrorBox>
    </motion.div>
  );
}

export default function Dues() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const dues = useActiveDues(me.groupId);
  const receipts = useMyPayments(me.groupId, me.uid);
  const [params, setParams] = useSearchParams();
  const checked = useRef(false);

  // Coming back from Paystack: confirm the payment straight away.
  useEffect(() => {
    const ref = params.get('reference');
    if (!ref || checked.current) return;
    checked.current = true;
    api
      .verifyPayment({ reference: ref })
      .then((r) =>
        r.status === 'paid'
          ? toast('Payment successful ✓', 'success', 'Your receipt is below.')
          : toast('Payment not completed', 'info', 'If money left your account, it will show here within a few minutes.'),
      )
      .catch((e) => toast('Could not confirm payment yet', 'error', errorText(e)))
      .finally(() => setParams({}, { replace: true }));
  }, [params, setParams]);

  return (
    <>
      <TopBar title="CDS dues" sub={group?.name} />
      <Page className="space-y-4">
        {dues === undefined ? (
          <div className="card h-40 animate-pulse" />
        ) : dues.length === 0 ? (
          <div className="card text-center">
            <p className="font-bold">No dues right now</p>
            <p className="text-sm text-muted">When your excos add dues, they'll show here.</p>
          </div>
        ) : (
          dues.map((d) => <DuesCard key={d.id} dues={d} hasAccount={!!group?.payout} />)
        )}

        {group?.payout && (
          <div className="card flex items-center gap-3 !p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-green-light text-green">
              <Icon name="bank" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-muted">Dues go straight to</p>
              <p className="truncate font-bold">
                {group.payout.accountName} · {group.payout.bankName} ****{group.payout.last4}
              </p>
            </div>
          </div>
        )}

        <div className="card !p-0">
          <p className="px-5 pb-2 pt-4 font-bold">Receipts</p>
          {!receipts || receipts.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {receipts.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{r.duesTitle}</p>
                    <p className="text-xs text-muted">
                      {r.method === 'cash' ? 'Cash' : 'Online'} · {r.paidAt?.toDate().toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
                      {r.reference.slice(-8).toUpperCase()}
                    </p>
                  </div>
                  <Pill>{naira(r.amountKobo)}</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/member/Home.tsx`

```tsx
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Icon, Page, Pill } from '../../components/ui';
import { useMyDay } from '../../hooks/useMyDay';
import { aheadOf, batchLabel } from '../../lib/rules';
import { getPending } from '../../lib/offlineQueue';

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const { me, group, session, att, status, tag } = useMyDay();
  const pending = getPending();
  const open = session?.status === 'open';

  return (
    <>
      <header className="hero-green relative px-5 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-8 lg:pt-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
            <span className="font-extrabold">CDS Pass</span>
          </div>
          {me.role === 'exco' && (
            <Link to="/exco" className="rounded-full bg-white/15 px-3 py-2 text-xs font-bold">
              Exco mode →
            </Link>
          )}
        </div>
        <div className="mt-6 flex items-center gap-3">
          <Avatar src={me.photoURL} name={me.fullName} size={56} ring />
          <div className="min-w-0">
            <p className="text-sm text-green-mid">{greeting()},</p>
            <h1 className="truncate text-2xl font-extrabold leading-tight">{me.fullName.split(' ')[0]}</h1>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">{me.stateCode}</span>
              <span className="max-w-[160px] truncate rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">{group?.name ?? '…'}</span>
            </div>
          </div>
        </div>
      </header>

      <Page className="relative z-10 -mt-14 space-y-4 lg:!px-6">
        {!att && <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className={`card flex flex-col items-center gap-3 text-center ${open ? '' : 'border-2 border-gold/60'}`}>
          <span className={`grid h-14 w-14 place-items-center rounded-2xl ${open ? 'bg-green text-white' : 'bg-gold-bg text-gold-text'}`}>
            <Icon name={open ? 'scan' : 'bell'} size={26} />
          </span>
          {!open && !att && (
            <>
              <Pill tone="gold">No meeting open</Pill>
              <p className="text-lg font-extrabold">Today's CDS hasn't started</p>
              <p className="text-sm text-muted">When an exco opens the meeting, scan the code at the door to get your number.</p>
            </>
          )}

          {open && !att && (
            <>
              <Pill>Meeting is open</Pill>
              <p className="text-lg font-extrabold">You're not checked in yet</p>
              <Link
                to="/scan"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gold font-bold text-[#3d2e00] shadow-[0_8px_0_#B39B5A] active:translate-y-[5px] active:shadow-[0_3px_0_#B39B5A]"
              >
                <Icon name="scan" /> Scan in at the door
              </Link>
              {pending && <p className="text-sm font-semibold text-warn">A saved scan will be sent when you're back online.</p>}
            </>
          )}

        </motion.div>}

        {!att && (
          <div className="grid grid-cols-2 gap-3">
            <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.08 }} className="rounded-3xl bg-green-light p-4">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-green shadow-card">
                <Icon name="door" size={18} />
              </span>
              <p className="mt-3 text-xs font-semibold text-green">Today's meeting</p>
              <p className="font-display text-xl font-extrabold text-green">{open ? 'Open now' : session?.status === 'closed' ? 'Ended' : 'Not open'}</p>
            </motion.div>
            <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.16 }}>
              <Link to="/dues" className="block h-full rounded-3xl bg-gold-bg p-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-gold-text shadow-card">
                  <Icon name="card" size={18} />
                </span>
                <p className="mt-3 text-xs font-semibold text-gold-text">Dues</p>
                <p className="font-display text-xl font-extrabold text-gold-text">Check & pay →</p>
              </Link>
            </motion.div>
          </div>
        )}

        {att && (
          <>
            <motion.div
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className={`number-card relative overflow-hidden rounded-[30px] p-6 text-white ${status === 'turn' && session?.status !== 'closed' ? 'turn-glow' : ''}`}
            >
              <span className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full border-[28px] border-white/[0.07]" />
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                  session?.status === 'closed' ? 'bg-white/15 text-white' : status === 'turn' ? 'bg-gold text-[#3d2e00]' : 'bg-white/15 text-white'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${status === 'turn' && session?.status !== 'closed' ? 'bg-[#3d2e00]' : 'bg-white'}`} />
                {session?.status === 'closed'
                  ? 'Meeting ended'
                  : status === 'turn'
                    ? "It's your turn!"
                    : status === 'done'
                      ? 'Thumbprinted ✓'
                      : 'Checked in'}
              </span>
              <p className="mt-4 text-xs font-bold tracking-[0.25em] text-green-mid">YOUR NUMBER</p>
              <motion.p
                key={tag}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 220, damping: 16 }}
                className="font-display text-[92px] font-extrabold leading-[0.95]"
                style={{ textShadow: '0 5px 0 rgba(0,0,0,.14)' }}
              >
                {tag}
              </motion.p>
            </motion.div>

            <div className="grid grid-cols-2 gap-3">
              <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.08 }} className="rounded-3xl bg-green-light p-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-green shadow-card">
                  <Icon name="megaphone" size={18} />
                </span>
                <p className="mt-3 text-xs font-semibold text-green">Now calling</p>
                <motion.p key={batchLabel(session?.batch)} initial={{ rotateX: 90 }} animate={{ rotateX: 0 }} className="font-display text-2xl font-extrabold text-green">
                  {batchLabel(session?.batch)}
                </motion.p>
              </motion.div>
              <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.16 }} className="rounded-3xl bg-gold-bg p-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-gold-text shadow-card">
                  <Icon name="users" size={18} />
                </span>
                <p className="mt-3 text-xs font-semibold text-gold-text">Ahead of you</p>
                <p className="font-display text-2xl font-extrabold text-gold-text">
                  {status === 'waiting' ? `${aheadOf(att, session?.batch)} people` : '—'}
                </p>
              </motion.div>
            </div>

            <Link to="/tag" className="card flex items-center justify-between !py-4">
              <span className="font-display font-bold">Open my tag</span>
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-green text-white">→</span>
            </Link>
          </>
        )}

        {status === 'turn' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex items-center gap-3 rounded-3xl border-2 border-gold bg-gold-bg p-4 text-gold-text"
          >
            <Icon name="finger" size={30} />
            <div>
              <p className="font-extrabold">Go to the thumbprint table now</p>
              <p className="text-sm opacity-80">Show your tag and your NYSC ID card.</p>
            </div>
          </motion.div>
        )}

        <div className="card space-y-3">
          <h3 className="font-bold">How it works</h3>
          {[
            ['scan', 'Scan the code at the door to get your number.'],
            ['bell', 'Sit down. Your phone buzzes when your batch is called.'],
            ['finger', 'Show your tag at the table, then thumbprint.'],
          ].map(([icon, text], i) => (
            <div key={text} className="flex items-center gap-3 text-sm">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${i === 2 ? 'bg-gold-bg text-gold-text' : 'bg-green-light text-green'}`}>
                <Icon name={icon} size={20} />
              </span>
              {text}
            </div>
          ))}
        </div>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/member/MyTag.tsx`

```tsx
import { motion } from 'framer-motion';
import { QRCodeCanvas } from 'qrcode.react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TagCard3D } from '../../components/TagCard3D';
import { Button, Page, TopBar } from '../../components/ui';
import { useMyDay } from '../../hooks/useMyDay';
import { aheadOf, batchLabel, memberQR } from '../../lib/rules';
import { saveTag, shareTag, type TagImageInput } from '../../lib/tagImage';
import { toast } from '../../lib/toast';

export default function MyTag() {
  const { me, group, session, att, status, tag } = useMyDay();
  const qrBox = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'' | 'share' | 'save'>('');

  const input = (): TagImageInput => ({
    name: me.fullName,
    stateCode: me.stateCode,
    groupName: group?.name,
    tag,
    status,
    photoURL: me.photoURL,
    qrCanvas: qrBox.current?.querySelector('canvas') ?? null,
  });

  async function onShare() {
    setBusy('share');
    try {
      const r = await shareTag(input());
      if (r === 'saved') toast('Tag saved as an image', 'success', 'Find it in your downloads or gallery.');
    } catch {
      toast('Could not create the image', 'error');
    } finally {
      setBusy('');
    }
  }

  async function onSave() {
    setBusy('save');
    try {
      await saveTag(input());
      toast('Tag saved as an image', 'success', 'Find it in your downloads or gallery.');
    } catch {
      toast('Could not create the image', 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={`min-h-[100dvh] transition-colors duration-500 ${status === 'turn' ? 'bg-green' : 'bg-paper'}`}>
      <TopBar title="My tag" sub={group?.name} />
      <Page className="space-y-5">
        <TagCard3D
          uid={me.uid}
          name={me.fullName}
          stateCode={me.stateCode}
          photoURL={me.photoURL}
          groupName={group?.name}
          tag={tag}
          status={status}
        />

        {/* Hidden high-resolution QR used to draw the shareable image */}
        <div ref={qrBox} className="hidden" aria-hidden="true">
          <QRCodeCanvas value={memberQR(me.uid)} size={600} level="M" fgColor="#03301A" marginSize={0} />
        </div>

        <div className="mx-auto grid w-full max-w-[340px] grid-cols-2 gap-3">
          <Button loading={busy === 'share'} onClick={onShare}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
            </svg>
            Share
          </Button>
          <Button variant="light" loading={busy === 'save'} onClick={onSave}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
            </svg>
            Save image
          </Button>
        </div>

        {att && session?.status !== 'closed' ? (
          <motion.div className="grid grid-cols-2 gap-3">
            <div className="card !p-4">
              <p className="text-xs font-semibold text-muted">Now calling</p>
              <p className="text-2xl font-extrabold text-green">{batchLabel(session?.batch)}</p>
            </div>
            <div className="card !p-4">
              <p className="text-xs font-semibold text-muted">{status === 'done' ? 'Done at' : 'Ahead of you'}</p>
              <p className="text-2xl font-extrabold">
                {status === 'done'
                  ? att.doneAt?.toDate().toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }) ?? '✓'
                  : status === 'turn'
                    ? 'Go now'
                    : aheadOf(att, session?.batch)}
              </p>
            </div>
          </motion.div>
        ) : att ? (
          <div className="card text-center">
            <p className="font-extrabold">Today's meeting has ended</p>
            <p className="mt-1 text-sm text-muted">Your attendance record is saved. Check back when your exco opens another meeting.</p>
          </div>
        ) : (
          <Link to="/scan" className="block rounded-2xl bg-green py-4 text-center font-bold text-white">
            Scan in to get your number
          </Link>
        )}

        {session?.status !== 'closed' && <p className={`text-center text-sm ${status === 'turn' ? 'text-white' : 'text-muted'}`}>
          At the table, tap the card to show your QR. The exco scans it and checks your NYSC ID card.
        </p>}
      </Page>
    </div>
  );
}
```

---

### `web/src/pages/member/Profile.tsx`

```tsx
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { PhotoPicker } from '../../components/PhotoPicker';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Button, ErrorBox, Field, Icon, Page, Pill, TopBar } from '../../components/ui';
import { useAuth, useMe } from '../../hooks/useAuth';
import { useGroup } from '../../hooks/useLive';
import { db, errorText } from '../../lib/firebase';
import { enableNotifications, pushState, type PushState } from '../../lib/messaging';
import { normalizePhone } from '../../lib/rules';
import { toast } from '../../lib/toast';
import { uploadAvatar } from '../../lib/upload';

export default function Profile() {
  const me = useMe();
  const { logout } = useAuth();
  const group = useGroup(me.groupId);
  const [push, setPush] = useState<PushState>('default');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [phone, setPhone] = useState(me.phone);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void pushState(me.uid).then(setPush);
  }, [me.uid]);

  async function turnOnPush() {
    setError('');
    setBusy('push');
    try {
      await enableNotifications(me.uid);
      setPush('enabled');
      toast('Notifications on', 'success', "We'll buzz you when your batch is called.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function save() {
    setError('');
    const p = normalizePhone(phone);
    if (!p) return setError('Enter a valid Nigerian phone number.');
    setBusy('save');
    try {
      const patch: Record<string, unknown> = { phone: p, updatedAt: serverTimestamp() };
      if (photo) patch.photoURL = await uploadAvatar(me.uid, photo);
      await updateDoc(doc(db, 'users', me.uid), patch);
      setPhoto(null);
      toast('Profile saved', 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <TopBar title="Profile" sub={group?.name} />
      <Page className="space-y-4">
        <div className="card">
          <PhotoPicker value={photo} currentPhotoURL={me.photoURL} onChange={(b, err) => (setPhoto(b), setError(err ?? ''))} />
          {!photo && me.photoURL && (
            <p className="mt-3 text-center text-xs text-muted">Your current photo is shown on your tag. Pick a new one to replace it.</p>
          )}
        </div>

        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-extrabold">{me.fullName}</p>
              <p className="text-sm font-semibold text-muted">{me.stateCode}</p>
            </div>
            <Pill>{me.role === 'exco' ? 'Exco' : 'Member'}</Pill>
          </div>
          <Field label="Phone number" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <p className="text-xs text-muted">To change your name or state code, ask an exco. They must match your NYSC ID card.</p>
          <Button loading={busy === 'save'} onClick={save}>
            Save changes
          </Button>
        </div>

        <div className="card space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-light text-green">
              <Icon name="bell" />
            </span>
            <div className="flex-1">
              <p className="font-bold">Batch alerts</p>
              <p className="text-sm text-muted">
                {push === 'enabled'
                  ? 'Enabled on this device. Your phone can buzz when your batch is called.'
                  : push === 'granted'
                    ? 'Browser permission is allowed. Connect this device to turn on batch alerts.'
                  : push === 'denied'
                    ? 'Blocked. Allow notifications in your browser settings.'
                    : push === 'unsupported'
                      ? 'Not available on this browser. Keep CDS Pass open on CDS day.'
                      : 'Get a buzz when it is your turn to thumbprint.'}
              </p>
            </div>
          </div>
          {push !== 'enabled' && push !== 'denied' && push !== 'unsupported' && (
            <Button variant="ghost" loading={busy === 'push'} onClick={turnOnPush}>
              Turn on alerts
            </Button>
          )}
        </div>

        <div className="card">
          <ThemeToggle />
        </div>

        <ErrorBox>{error}</ErrorBox>

        <Button variant="outline" onClick={logout}>
          <Icon name="logout" /> Log out
        </Button>
        <p className="text-center text-xs text-muted">CDS Pass is an independent tool for CDS groups. Not affiliated with NYSC.</p>
      </Page>
    </>
  );
}
```

---

### `web/src/pages/member/ScanIn.tsx`

```tsx
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Icon, Page, TopBar } from '../../components/ui';
import { useMyDay } from '../../hooks/useMyDay';
import { api } from '../../lib/api';
import { getPosition } from '../../lib/device';
import { errorText } from '../../lib/firebase';
import { savePending } from '../../lib/offlineQueue';
import { parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function ScanIn() {
  const nav = useNavigate();
  const { me, att, tag, group } = useMyDay();
  const [typing, setTyping] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set when the server refuses because dues are not paid: shows the red "pay first" screen. */
  const [unpaid, setUnpaid] = useState('');

  async function send(c: string, gid?: string) {
    if (busy) return;
    setError('');
    if (gid && gid !== me.groupId) return setError('That code is for a different CDS group.');
    setBusy(true);
    const scannedAt = Date.now();
    const pos = group?.venue ? await getPosition() : null;
    const payload = { code: c, gid, ...(pos ?? {}) };

    if (!navigator.onLine) {
      savePending({ ...payload, scannedAt });
      setBusy(false);
      toast('Scan saved', 'info', "No data right now. We'll send it as soon as you're back online.");
      return nav('/home');
    }
    try {
      const r = await api.checkIn(payload);
      navigator.vibrate?.([80, 60, 80]);
      toast(r.already ? `You're already No. ${r.number}` : `You're No. ${r.number}`, 'success', 'Sit down. We will buzz you when your batch is called.');
      nav('/tag');
    } catch (e) {
      const msg = errorText(e);
      if (/internet/i.test(msg)) {
        savePending({ ...payload, scannedAt });
        toast('Scan saved', 'info', "We'll send it when your connection is back.");
        nav('/home');
      } else if (/^Dues not paid/i.test(msg)) {
        navigator.vibrate?.([200, 100, 200]);
        setUnpaid(msg.replace(/^Dues not paid:\s*/i, ''));
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  function onScan(text: string) {
    const q = parseQR(text);
    if (q?.type === 'door') void send(q.code, q.gid);
    else setError('That is not a CDS Pass door code. Scan the code on the exco’s screen.');
  }

  if (unpaid) {
    return (
      <>
        <TopBar title="Scan in" back="/home" />
        <Page className="space-y-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="rounded-[30px] bg-bad p-6 text-center text-white shadow-lift"
          >
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-white/15">
              <Icon name="card" size={32} />
            </span>
            <p className="mt-4 font-display text-2xl font-extrabold">Please pay your dues</p>
            <p className="mt-2 text-sm text-white/90">{unpaid}</p>
            <p className="mt-3 text-xs font-semibold text-white/80">No number has been given yet.</p>
          </motion.div>
          <Button variant="gold" onClick={() => nav('/dues')}>
            <Icon name="card" /> Pay online now
          </Button>
          <div className="card text-sm">
            <p className="font-bold">Paying cash?</p>
            <p className="text-muted">Give the cash to an exco. Once they tap “Paid (cash)” on your name, scan the door code again.</p>
          </div>
          <Button variant="outline" onClick={() => setUnpaid('')}>
            I've paid, scan again
          </Button>
        </Page>
      </>
    );
  }

  if (att) {
    return (
      <>
        <TopBar title="Scan in" back="/home" />
        <Page className="grid place-items-center text-center">
          <div className="card w-full">
            <p className="text-sm text-muted">You're already checked in today</p>
            <p className="text-7xl font-extrabold text-green">{tag}</p>
            <Button className="mt-4" onClick={() => nav('/tag')}>
              Open my tag
            </Button>
          </div>
        </Page>
      </>
    );
  }

  return (
    <>
      <TopBar title="Scan in" back="/home" sub="Point your camera at the code on the exco's screen" />
      <Page className="space-y-4">
        <AnimatePresence mode="wait">
          {!typing ? (
            <motion.div key="cam" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <QRScan onResult={onScan} paused={busy} className="aspect-square w-full shadow-lift" />
            </motion.div>
          ) : (
            <motion.div key="type" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="card space-y-4">
              <p className="font-bold">Type the 6-digit code under the QR</p>
              <input
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                aria-label="6-digit door code"
                className="input h-20 text-center text-4xl font-extrabold tracking-[0.35em]"
              />
              <Button loading={busy} disabled={code.length !== 6} onClick={() => send(code)}>
                Check in
              </Button>
              <p className="text-center text-xs text-muted">The code changes every 30 seconds. Type the one you see now.</p>
            </motion.div>
          )}
        </AnimatePresence>

        <ErrorBox>{error}</ErrorBox>
        {busy && !typing && <p className="text-center font-semibold text-green">Checking you in…</p>}

        <button
          onClick={() => {
            setTyping((t) => !t);
            setError('');
          }}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-card font-bold text-green shadow-card"
        >
          <Icon name={typing ? 'camera' : 'keypad'} />
          {typing ? 'Use the camera instead' : "Camera not working? Type the code"}
        </button>

        <p className="px-2 text-center text-sm text-muted">
          Phone dead or no camera at all? Go to the exco at the door with your NYSC ID card.
          {group?.venue ? ' Location must be on so we can confirm you are at the venue.' : ''}
        </p>
      </Page>
    </>
  );
}
```

---

### `web/tailwind.config.js`

```js
/** @type {import('tailwindcss').Config} */

// Colours come from CSS variables (see src/index.css) so the whole app
// switches between light and dark mode without changing any component.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        green: {
          DEFAULT: v('green'),
          dark: '#064726',
          deep: '#03301A',
          light: v('green-light'),
          mid: '#CFE6D6',
        },
        // Fixed NYSC green, for text that sits on something that is always white.
        brand: '#0B6B3A',
        paper: v('paper'),
        card: v('card'),
        ink: v('ink'),
        muted: v('muted'),
        line: v('line'),
        khaki: '#C9B783',
        // Soft gold accent: small touches only (badges, one tile, avatar ring).
        gold: { DEFAULT: '#D9C58A', bg: v('gold-bg'), text: v('gold-text') },
        warn: { DEFAULT: v('warn'), bg: v('warn-bg') },
        bad: { DEFAULT: '#B42318', bg: v('bad-bg') },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        display: ['Poppins', '"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 10px 30px rgb(var(--shadow) / 0.12)',
        lift: '0 24px 60px rgba(3, 48, 26, 0.35)',
      },
    },
  },
  plugins: [],
};
```

---

### `web/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

---

### `web/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep Firebase in its own cached file. Do NOT list the 3D libraries here: naming them as a
        // manual chunk made every phone download ~960 KB of 3D code before the app could start.
        // Left alone, they stay inside the lazily loaded Hero3D file and only load on the welcome screen.
        manualChunks(id) {
          if (id.includes('/node_modules/firebase/') || id.includes('/node_modules/@firebase/')) return 'firebase';
        },
      },
    },
  },
});
```
