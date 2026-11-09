# CDS Pass — Complete Handover Document

> **For any developer or AI reading this:** this file describes the whole CDS Pass application — what it does,
> how it is built, how data flows, every API action, how to run and deploy it, known issues — and then contains
> **the full source code of every file**. Read sections 1–9 first; section 10 is the code.
> Project owner: Daniel Success (Derik / DerikWebX). Local path on the owner's PC: `C:\Projects\cds-pass` (Windows).

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
- `server/src/shared.ts`
- `server/tsconfig.json`
- `web/.env.example`
- `web/index.html`
- `web/package.json`
- `web/postcss.config.js`
- `web/public/firebase-messaging-sw.js`
- `web/public/icon.svg`
- `web/public/manifest.webmanifest`
- `web/src/App.tsx`
- `web/src/components/Avatar.tsx`
- `web/src/components/BottomNav.tsx`
- `web/src/components/ErrorBoundary.tsx`
- `web/src/components/ExcoHeader.tsx`
- `web/src/components/Hero3D.tsx`
- `web/src/components/InstallGate.tsx`
- `web/src/components/MemberCard.tsx`
- `web/src/components/PhotoPicker.tsx`
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
- `web/src/index.css`
- `web/src/lib/api.ts`
- `web/src/lib/device.ts`
- `web/src/lib/firebase.ts`
- `web/src/lib/image.ts`
- `web/src/lib/install.ts`
- `web/src/lib/messaging.ts`
- `web/src/lib/money.ts`
- `web/src/lib/offlineQueue.ts`
- `web/src/lib/rules.ts`
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
- `web/src/pages/exco/CallBatch.tsx`
- `web/src/pages/exco/Dashboard.tsx`
- `web/src/pages/exco/Door.tsx`
- `web/src/pages/exco/DuesAdmin.tsx`
- `web/src/pages/exco/Members.tsx`
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
    "origin": ["*"],
    "method": ["GET"],
    "maxAgeSeconds": 3600
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
  "storage": {
    "rules": "storage.rules"
  },
  "hosting": {
    "public": "web/dist",
    "predeploy": [
      "npm --prefix web run build"
    ],
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ],
    "headers": [
      {
        "source": "/firebase-messaging-sw.js",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "no-cache"
          }
        ]
      },
      {
        "source": "/assets/**",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "public, max-age=31536000, immutable"
          }
        ]
      }
    ]
  },
  "emulators": {
    "auth": {
      "port": 9099
    },
    "firestore": {
      "port": 8080
    },
    "storage": {
      "port": 9199
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
      - key: CORS_ORIGINS # e.g. https://your-id.web.app
        sync: false
      - key: FIREBASE_SERVICE_ACCOUNT # service-account JSON (or base64 of it)
        sync: false
      - key: FIREBASE_STORAGE_BUCKET # e.g. your-id.firebasestorage.app
        sync: false
      - key: PAYSTACK_SECRET_KEY
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

# Talk to the Firebase emulators running on this PC
GCLOUD_PROJECT=demo-cds-pass
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199

# Online dues charges on top of the dues: 3% yours + 1.5% for Paystack
SERVICE_FEE_PERCENT=3
PAYSTACK_FEE_PERCENT=1.5

# For online payments, put PAYSTACK_SECRET_KEY=sk_test_... in keys.env and run `npm run dev:keys`
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
    "cors": "^2.8.5",
    "express": "^4.21.1",
    "firebase-admin": "^12.6.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
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
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
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
const attendeeRef = (gid: string, sid: string, uid: string) =>
  db.doc(`groups/${gid}/sessions/${sid}/attendees/${uid}`);

async function log(gid: string, by: string, action: string, detail: Record<string, unknown> = {}) {
  await db.collection(`groups/${gid}/logs`).add({
    at: FieldValue.serverTimestamp(),
    sessionId: lagosDate(),
    by,
    action,
    ...detail,
  });
}

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

function text(v: unknown, label: string, min: number, max: number): string {
  if (typeof v !== 'string') throw fail('invalid-argument', `${label} is required.`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) {
    throw fail('invalid-argument', `${label} must be ${min}–${max} characters.`);
  }
  return s;
}

function doorCode(secret: string, gid: string, sid: string, window: number): string {
  const h = createHmac('sha256', secret).update(`${gid}|${sid}|${window}`).digest();
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

  const photoURL = data?.photoURL;
  if (typeof photoURL !== 'string' || !/^https?:\/\//.test(photoURL) || photoURL.length > 2000) {
    throw fail('invalid-argument', 'A profile picture is required.');
  }

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

  return db.runTransaction(async (tx) => {
    const sRef = sessionRef(gid, sid);
    const aRef = attendeeRef(gid, sid, uid);
    const [s, a] = await Promise.all([tx.get(sRef), tx.get(aRef)]);
    if (!s.exists || s.data()!.status !== 'open') {
      throw fail('failed-precondition', "Today's CDS meeting has not been opened by an exco yet.");
    }
    if (a.exists) return { number: a.data()!.number as number, already: true };

    const number = s.data()!.nextNumber as number;
    tx.update(sRef, { nextNumber: number + 1 });
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

async function notify(uids: string[], title: string, body: string, link = '/tag'): Promise<number> {
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
      data: { title, body, link },
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

// ---------------------------------------------------------------- accounts

/** New corps member joins a CDS group with the group's join code. Starts as "pending". */
export const registerMember = onCall(async (req) => {
  const { uid } = signedIn(req);
  const p = await validateProfile(uid, req.data);
  const joinCode = String(req.data?.joinCode ?? '').trim().toUpperCase();
  if (joinCode.length !== 6) throw fail('invalid-argument', 'Enter the 6-character CDS group code.');

  const g = await db.collection('groups').where('joinCode', '==', joinCode).limit(1).get();
  if (g.empty) throw fail('not-found', 'No CDS group with that code. Ask your exco for it.');
  const gid = g.docs[0].id;

  await userRef(uid).set({
    ...p,
    groupId: gid,
    role: 'member',
    status: 'pending',
    fcmTokens: [],
    createdAt: FieldValue.serverTimestamp(),
  });
  await auth.setCustomUserClaims(uid, { gid, role: 'member', approved: false });
  await log(gid, uid, 'member_registered', { target: uid, stateCode: p.stateCode });
  return { ok: true, status: 'pending', groupName: g.docs[0].data().name };
});

/** An exco creates a new CDS group and becomes its first exco. */
export const createGroup = onCall(async (req) => {
  const { uid } = signedIn(req);
  const p = await validateProfile(uid, req.data);
  const name = text(req.data?.group?.name, 'CDS group name', 3, 60);
  const lga = text(req.data?.group?.lga, 'LGA', 2, 60);
  const state = text(req.data?.group?.state, 'State', 2, 40);

  let joinCode = newJoinCode();
  for (let i = 0; i < 5; i++) {
    const clash = await db.collection('groups').where('joinCode', '==', joinCode).limit(1).get();
    if (clash.empty) break;
    joinCode = newJoinCode();
  }

  const gRef = db.collection('groups').doc();
  const batch = db.batch();
  batch.set(gRef, {
    name,
    lga,
    state,
    joinCode,
    batchSize: DEFAULT_BATCH_SIZE,
    venue: null,
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(keysRef(gRef.id), { doorSecret: randomBytes(32).toString('hex') });
  batch.set(userRef(uid), {
    ...p,
    groupId: gRef.id,
    role: 'exco',
    status: 'approved',
    fcmTokens: [],
    createdAt: FieldValue.serverTimestamp(),
    approvedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  await auth.setCustomUserClaims(uid, { gid: gRef.id, role: 'exco', approved: true });
  await log(gRef.id, uid, 'group_created', { name });
  return { ok: true, groupId: gRef.id, joinCode };
});

/** Exco approves (after checking the NYSC ID card) or rejects a pending member. */
export const approveMember = onCall(async (req) => {
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
  return { ok: true };
});

/** Make someone an exco (or back to member). */
export const setRole = onCall(async (req) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const role: Role = req.data?.role === 'exco' ? 'exco' : 'member';
  if (uid === e.uid && role !== 'exco') throw fail('failed-precondition', 'You cannot remove yourself as exco.');
  if (user.status !== 'approved') throw fail('failed-precondition', 'Approve this member first.');
  await userRef(uid).update({ role });
  await auth.setCustomUserClaims(uid, { gid: e.gid, role, approved: true });
  await log(e.gid, e.uid, 'role_changed', { target: uid, role });
  return { ok: true };
});

/** Exco resets a member's PIN after checking their NYSC ID card. */
export const resetPin = onCall(async (req) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const pin = String(req.data?.pin ?? '');
  if (!/^\d{6}$/.test(pin)) throw fail('invalid-argument', 'The new PIN must be 6 digits.');
  await auth.updateUser(uid, { password: pin });
  await log(e.gid, e.uid, 'pin_reset', { target: uid, stateCode: user.stateCode });
  return { ok: true };
});

/** Batch size and venue location. */
export const updateGroupSettings = onCall(async (req) => {
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
  return { ok: true };
});

// ---------------------------------------------------------------- CDS day

export const startSession = onCall(async (req) => {
  const e = await exco(req);
  const sid = lagosDate();
  const ref = sessionRef(e.gid, sid);
  const snap = await ref.get();
  if (snap.exists) {
    await ref.update({ status: 'open', reopenedAt: FieldValue.serverTimestamp() });
  } else {
    await ref.set({
      status: 'open',
      openedAt: FieldValue.serverTimestamp(),
      openedBy: e.uid,
      nextNumber: 1,
      nextPriority: 1,
      lastTo: 0,
      batchSeq: 0,
      batch: null,
    });
  }
  await log(e.gid, e.uid, 'session_opened', { sessionId: sid });
  return { ok: true, sessionId: sid };
});

export const endSession = onCall(async (req) => {
  const e = await exco(req);
  const sid = lagosDate();
  await sessionRef(e.gid, sid).update({ status: 'closed', closedAt: FieldValue.serverTimestamp() });
  await log(e.gid, e.uid, 'session_closed', { sessionId: sid });
  return { ok: true };
});

/** The exco's door screen asks for a fresh code every ~25 seconds. */
export const getDoorCode = onCall(async (req) => {
  const e = await exco(req);
  const sid = lagosDate();
  const s = await sessionRef(e.gid, sid).get();
  if (!s.exists || s.data()!.status !== 'open') {
    throw fail('failed-precondition', "Open today's CDS meeting first.");
  }
  const secret = (await keysRef(e.gid).get()).data()?.doorSecret as string;
  const now = Date.now();
  const w = Math.floor(now / WINDOW_MS);
  return { code: doorCode(secret, e.gid, sid, w), gid: e.gid, sessionId: sid, expiresAt: (w + 1) * WINDOW_MS };
});

/**
 * A member scans the door QR (or types the 6-digit code).
 * `scannedAt` is set when the scan was saved offline and is being sent later.
 */
export const checkIn = onCall(async (req) => {
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

  const [g, keys] = await Promise.all([groupRef(gid).get(), keysRef(gid).get()]);
  const secret = keys.data()?.doorSecret as string | undefined;
  if (!secret) throw fail('internal', 'Group is not set up correctly.');

  const w = Math.floor(at / WINDOW_MS);
  if (![w, w - 1].some((x) => doorCode(secret, gid, sid, x) === code)) {
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
export const lookupMember = onCall(async (req) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const a = await attendeeRef(e.gid, lagosDate(), uid).get();
  return { member: publicMember(uid, user), attendee: a.exists ? a.data() : null };
});

/** Exco checks in someone without a working phone (printed card, or manual by state code). */
export const excoCheckIn = onCall(async (req) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const method = req.data?.method === 'card' ? 'card' : 'manual';
  const r = await admit(e.gid, lagosDate(), uid, method, e.uid, Date.now());
  if (!r.already && method === 'manual') {
    await log(e.gid, e.uid, 'manual_checkin', { target: uid, stateCode: user.stateCode, number: r.number });
  }
  return { ...r, member: publicMember(uid, user) };
});

/** Pregnant and nursing mothers get a priority tag (P1, P2 …). The reason is never stored. */
export const setPriority = onCall(async (req) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const sid = lagosDate();
  const pNumber = await db.runTransaction(async (tx) => {
    const sRef = sessionRef(e.gid, sid);
    const aRef = attendeeRef(e.gid, sid, uid);
    const [s, a] = await Promise.all([tx.get(sRef), tx.get(aRef)]);
    if (!a.exists) throw fail('failed-precondition', 'Check this person in first.');
    if (a.data()!.priority) return a.data()!.pNumber as number;
    const n = s.data()!.nextPriority as number;
    tx.update(sRef, { nextPriority: n + 1 });
    tx.update(aRef, { priority: true, pNumber: n, priorityBy: e.uid });
    return n;
  });
  await log(e.gid, e.uid, 'priority_given', { target: uid, stateCode: user.stateCode, pNumber });
  return { ok: true, pNumber };
});

/** "Call priority" or "Call next batch". Notifies everyone in the batch. */
export const callNext = onCall(async (req) => {
  const e = await exco(req);
  const sid = lagosDate();
  const mode = req.data?.mode === 'priority' ? 'priority' : 'next';
  const g = await groupRef(e.gid).get();
  const size = (g.data()?.batchSize as number) ?? DEFAULT_BATCH_SIZE;

  const batch = await db.runTransaction(async (tx) => {
    const sRef = sessionRef(e.gid, sid);
    const s = await tx.get(sRef);
    if (!s.exists || s.data()!.status !== 'open') throw fail('failed-precondition', "Open today's CDS meeting first.");
    const d = s.data()!;
    const seq = (d.batchSeq as number) + 1;
    let b: Batch;
    if (mode === 'priority') {
      if ((d.nextPriority as number) <= 1) throw fail('failed-precondition', 'Nobody has a priority tag yet.');
      b = { kind: 'priority', seq };
    } else {
      const from = (d.lastTo as number) + 1;
      if (from > (d.nextNumber as number) - 1) {
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
  const sent = await notify(targets, `${label}: it's your turn`, 'Go to the thumbprint table now and show your CDS Pass tag.');
  await log(e.gid, e.uid, 'batch_called', { label, notified: sent });
  return { ok: true, batch, notified: sent, inBatch: targets.length };
});

/** Exco scans a tag at the thumbprint table. Green = thumbprint, red = wait. */
export const tableCheck = onCall(async (req) => {
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
export const markDone = onCall(async (req) => {
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
export const listBanks = onCall({ secrets: [paystackSecret] }, async (req) => {
  await exco(req);
  const banks = await paystack<{ name: string; code: string; active: boolean }[]>('/bank?country=nigeria&perPage=200');
  return banks.filter((b) => b.active).map((b) => ({ name: b.name, code: b.code }));
});

/** Shows the account name before saving, so the wrong account isn't used. */
export const resolveAccount = onCall({ secrets: [paystackSecret] }, async (req) => {
  await exco(req);
  const acct = String(req.data?.accountNumber ?? '').replace(/\D/g, '');
  const bank = String(req.data?.bankCode ?? '');
  if (acct.length !== 10 || !bank) throw fail('invalid-argument', 'Enter a 10-digit account number and choose the bank.');
  const r = await paystack<{ account_name: string }>(`/bank/resolve?account_number=${acct}&bank_code=${encodeURIComponent(bank)}`);
  return { accountName: r.account_name };
});

/** Saves the group's dues account as a Paystack subaccount (created once, updated on handover). */
export const setPayoutAccount = onCall({ secrets: [paystackSecret] }, async (req) => {
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
  return { ok: true, accountName: account_name };
});

/** Exco creates a dues item, e.g. "November dues ₦1,000". */
export const createDues = onCall(async (req) => {
  const e = await exco(req);
  const title = text(req.data?.title, 'Title', 3, 60);
  const amount = Number(req.data?.amountNaira);
  if (!Number.isFinite(amount) || amount < 50 || amount > 100_000) throw fail('invalid-argument', 'Amount must be ₦50 – ₦100,000.');
  const dueDate = typeof req.data?.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.data.dueDate) ? req.data.dueDate : null;
  const ref = db.collection(`groups/${e.gid}/dues`).doc();
  await ref.set({
    title,
    amountKobo: Math.round(amount * 100),
    dueDate,
    active: true,
    createdBy: e.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  await log(e.gid, e.uid, 'dues_created', { label: `${title} · ${naira(Math.round(amount * 100))}` });
  return { ok: true, duesId: ref.id };
});

export const closeDues = onCall(async (req) => {
  const e = await exco(req);
  const duesId = String(req.data?.duesId ?? '');
  await duesRef(e.gid, duesId).update({ active: false, closedAt: FieldValue.serverTimestamp() });
  await log(e.gid, e.uid, 'dues_closed', { duesId });
  return { ok: true };
});

/** Member starts an online payment. Returns the Paystack checkout link. */
export const startPayment = onCall({ secrets: [paystackSecret] }, async (req) => {
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
export const verifyPayment = onCall({ secrets: [paystackSecret] }, async (req) => {
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
export const recordCash = onCall(async (req) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const duesId = String(req.data?.duesId ?? '');
  const d = await duesRef(e.gid, duesId).get();
  if (!d.exists) throw fail('not-found', 'Dues not found.');
  const st = await duesStatusRef(e.gid, duesId, uid).get();
  if (st.data()?.status === 'paid') throw fail('already-exists', `${user.fullName} has already paid.`);

  const reference = `cash-${e.gid}-${randomBytes(6).toString('hex')}`;
  const amountKobo = d.data()!.amountKobo as number;
  await paymentRef(e.gid, reference).set({
    reference,
    uid,
    duesId,
    duesTitle: d.data()!.title,
    amountKobo,
    feeKobo: 0,
    totalKobo: amountKobo,
    method: 'cash',
    status: 'awaiting_member',
    recordedBy: e.uid,
    recordedByName: e.name,
    fullName: user.fullName,
    stateCode: user.stateCode,
    createdAt: FieldValue.serverTimestamp(),
  });
  await duesStatusRef(e.gid, duesId, uid).set({
    uid,
    status: 'cash_pending',
    method: 'cash',
    amountKobo,
    reference,
    recordedBy: e.uid,
    recordedByName: e.name,
    fullName: user.fullName,
    stateCode: user.stateCode,
    recordedAt: FieldValue.serverTimestamp(),
  });
  await log(e.gid, e.uid, 'cash_recorded', { target: uid, stateCode: user.stateCode, label: naira(amountKobo) });
  await notify([uid], 'Confirm your cash payment', `${e.name} recorded ${naira(amountKobo)} cash for ${d.data()!.title}. Open CDS Pass to confirm.`, '/dues');
  return { ok: true };
});

/** Member confirms (or disputes) cash the treasurer recorded. */
export const respondCash = onCall(async (req) => {
  const { uid, gid } = approvedMember(req);
  const duesId = String(req.data?.duesId ?? '');
  const confirm = req.data?.confirm === true;
  const sRef = duesStatusRef(gid, duesId, uid);
  const st = await sRef.get();
  if (st.data()?.status !== 'cash_pending') throw fail('failed-precondition', 'There is no cash payment waiting for you.');
  const reference = st.data()!.reference as string;
  const batch = db.batch();
  if (confirm) {
    batch.update(sRef, { status: 'paid', paidAt: FieldValue.serverTimestamp() });
    batch.update(paymentRef(gid, reference), { status: 'paid', paidAt: FieldValue.serverTimestamp() });
  } else {
    batch.delete(sRef);
    batch.update(paymentRef(gid, reference), { status: 'disputed', disputedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  await log(gid, uid, confirm ? 'cash_confirmed' : 'cash_disputed', { target: uid, reference });
  return { ok: true };
});

/** Buzz everyone who hasn't paid yet. */
export const remindDues = onCall(async (req) => {
  const e = await exco(req);
  const duesId = String(req.data?.duesId ?? '');
  const d = await duesRef(e.gid, duesId).get();
  if (!d.exists) throw fail('not-found', 'Dues not found.');
  const [members, statuses] = await Promise.all([
    db.collection('users').where('groupId', '==', e.gid).get(),
    db.collection(`groups/${e.gid}/dues/${duesId}/status`).get(),
  ]);
  const paid = new Set(statuses.docs.filter((s) => s.data().status === 'paid').map((s) => s.id));
  const owing = members.docs.filter((m) => m.data().status === 'approved' && !paid.has(m.id)).map((m) => m.id);
  const sent = await notify(owing, `${d.data()!.title}: ${naira(d.data()!.amountKobo)}`, 'Tap to pay your CDS dues in CDS Pass.', '/dues');
  await log(e.gid, e.uid, 'dues_reminder', { label: d.data()!.title, notified: sent });
  return { ok: true, owing: owing.length, notified: sent };
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

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: origins, maxAge: 86400 }));

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
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
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
    <div id="root"></div>
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

### `web/src/App.tsx`

```tsx
import { useEffect } from 'react';
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
import Members from './pages/exco/Members';
import PrintCards from './pages/exco/PrintCards';
import Settings from './pages/exco/Settings';
import Table from './pages/exco/Table';

function Splash() {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-green-dark">
      <div className="flex flex-col items-center gap-4 text-white">
        <img src="/icon.svg" alt="" className="h-20 w-20 rounded-3xl shadow-lift" />
        <Spinner light />
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
  const { user, profile, ready } = useAuth();
  const lock = useSignupLock();

  useEffect(() => {
    if (ready) startOfflineSync();
  }, [ready]);

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
    return <Splash />;
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
        </Route>
        <Route path="/exco/cards" element={profile?.role === 'exco' ? <PrintCards /> : <Navigate to="/home" replace />} />
        <Route path="*" element={<Navigate to={homePath} replace />} />
      </Routes>
    );
  }

  return (
    <InstallGate>
      <Toaster />
      {routes}
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
    <header className="grid-bg bg-green-dark px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-7 lg:pb-6 lg:pt-6">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold tracking-[0.2em] text-green-mid">EXCO</p>
          <h1 className="truncate text-xl font-extrabold">{title}</h1>
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
    <div className="screen bg-green-dark text-white">
      <div className="grid-bg flex flex-1 flex-col px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
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
export function PhotoPicker({ value, onChange }: { value: Blob | null; onChange: (b: Blob | null, err?: string) => void }) {
  const cam = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return setPreview(null);
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  async function pick(f: File | undefined) {
    if (!f) return;
    try {
      onChange(await compressPhoto(f));
    } catch (e) {
      onChange(null, (e as Error).message);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <motion.div
        initial={{ scale: 0.9, rotate: -4 }}
        animate={{ scale: 1, rotate: 0 }}
        className="relative h-40 w-40 overflow-hidden rounded-full bg-green-light shadow-lift ring-8 ring-white"
      >
        {preview ? (
          <img src={preview} alt="Your profile" className="h-full w-full object-cover" />
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
        <button type="button" onClick={() => cam.current?.click()} className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-green font-bold text-white">
          <Icon name="camera" /> Take photo
        </button>
        <button type="button" onClick={() => gallery.current?.click()} className="flex h-14 items-center justify-center gap-2 rounded-2xl border-2 border-green bg-card font-bold text-green">
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
  const [state, setState] = useState<'starting' | 'on' | 'error'>('starting');
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
    scanner
      .start()
      .then(() => setState('on'))
      .catch((e: unknown) => {
        setState('error');
        const msg = String((e as Error)?.message ?? e);
        setError(
          /permission|denied|NotAllowed/i.test(msg)
            ? 'Camera permission is blocked. Allow the camera in your browser settings, or type the code instead.'
            : 'Could not open the camera on this phone. Type the code instead.',
        );
      });
    return () => {
      scanner.stop();
      scanner.destroy();
    };
  }, []);

  return (
    <div className={`relative mx-auto max-w-[480px] overflow-hidden rounded-3xl bg-green-deep ${className}`}>
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      {state === 'starting' && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner light size={32} />
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm font-semibold text-white">{error}</div>
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
import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'light';

const variants: Record<Variant, string> = {
  primary: 'bg-green text-white shadow-[0_8px_0_#064726] active:shadow-[0_3px_0_#064726] active:translate-y-[5px]',
  outline: 'border-2 border-green bg-card text-green',
  ghost: 'bg-green-light text-green',
  danger: 'bg-bad text-white shadow-[0_8px_0_#7A1810] active:shadow-[0_3px_0_#7A1810] active:translate-y-[5px]',
  light: 'bg-card text-green shadow-[0_8px_0_rgb(var(--line))] active:shadow-[0_3px_0_rgb(var(--line))] active:translate-y-[5px]',
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

export function Pill({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'warn' | 'bad' | 'muted' | 'white' }) {
  const tones = {
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
    <header className="sticky top-0 z-20 bg-green-dark/95 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white backdrop-blur lg:top-4 lg:rounded-3xl lg:px-6 lg:pt-4">
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

export function Stat({ value, label, tone = 'dark' }: { value: ReactNode; label: string; tone?: 'dark' | 'light' }) {
  return (
    <div className={`rounded-2xl p-3 ${tone === 'dark' ? 'bg-white/10 text-white' : 'bg-white text-ink shadow-card'}`}>
      <div className="text-2xl font-extrabold leading-tight">{value}</div>
      <div className={`text-xs font-semibold ${tone === 'dark' ? 'text-green-mid' : 'text-muted'}`}>{label}</div>
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
```

---

### `web/src/hooks/useAuth.tsx`

```tsx
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
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
        const t = await u.getIdTokenResult();
        setClaims({ gid: t.claims.gid as string, role: t.claims.role as Claims['role'], approved: t.claims.approved === true });
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    setProfile(undefined);
    return onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => setProfile(snap.exists() ? ({ uid: snap.id, ...snap.data() } as Profile) : null),
      () => setProfile(null),
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
    await signOut(auth);
  }, []);

  return (
    <Ctx.Provider value={{ user, profile, claims, ready, refreshClaims, logout }}>{children}</Ctx.Provider>
  );
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
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/firebase';
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

export function useLogs(gid: string | undefined, max = 50) {
  const q = useMemo(
    () => (gid ? query(collection(db, `groups/${gid}/logs`), orderBy('at', 'desc'), limit(max)) : null),
    [gid, max],
  );
  return useList<LogEntry>(q, `logs:${gid}:${max}`);
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
import { toast } from '../lib/toast';
import { useMe } from './useAuth';
import { useGroup, useMyAttendee, useSession } from './useLive';

/** Everything a member needs for today: group, session, my tag and whether it's my turn. */
export function useMyDay() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const session = useSession(me.groupId);
  const att = useMyAttendee(me.groupId, me.uid);

  const turn = !!att && isTurn(att, session?.batch);
  const status: 'none' | 'waiting' | 'turn' | 'done' = !att ? 'none' : att.status === 'done' ? 'done' : turn ? 'turn' : 'waiting';

  // Buzz the phone the moment my batch is called (works whenever the site is open).
  const wasTurn = useRef(turn);
  useEffect(() => {
    if (turn && !wasTurn.current) {
      navigator.vibrate?.([400, 150, 400, 150, 400]);
      toast("It's your turn!", 'success', 'Go to the thumbprint table and show your tag.');
    }
    wasTurn.current = turn;
  }, [turn]);

  return { me, group, session, att, turn, status, tag: att ? tagLabel(att) : null };
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
  color-scheme: light;
}

@layer base {
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
  .grid-bg {
    background-image: radial-gradient(rgba(255, 255, 255, 0.09) 1px, transparent 1px);
    background-size: 18px 18px;
  }
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
import type { Attendee, Batch, PublicMember, TableCheckResponse } from './types';

interface ProfileInput {
  stateCode: string;
  fullName: string;
  phone: string;
  photoURL: string;
}
type Who = { uid?: string; stateCode?: string };

export const api = {
  // accounts
  registerMember: callable<ProfileInput & { joinCode: string }, { ok: true; status: string; groupName: string }>('registerMember'),
  createGroup: callable<ProfileInput & { group: { name: string; lga: string; state: string } }, { ok: true; groupId: string; joinCode: string }>('createGroup'),
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
  getDoorCode: callable<Record<string, never>, { code: string; gid: string; sessionId: string; expiresAt: number }>('getDoorCode'),
  checkIn: callable<
    { code: string; gid?: string; lat?: number; lng?: number; scannedAt?: number },
    { number: number; already: boolean; sessionId: string }
  >('checkIn'),
  lookupMember: callable<Who, { member: PublicMember; attendee: Attendee | null }>('lookupMember'),
  excoCheckIn: callable<Who & { method: 'card' | 'manual' }, { number: number; already: boolean; member: PublicMember }>('excoCheckIn'),
  setPriority: callable<Who, { ok: true; pNumber: number }>('setPriority'),
  callNext: callable<{ mode: 'priority' | 'next' }, { ok: true; batch: Batch; notified: number; inBatch: number }>('callNext'),
  tableCheck: callable<Who, TableCheckResponse>('tableCheck'),
  markDone: callable<Who, { ok: true }>('markDone'),

  // dues
  listBanks: callable<Record<string, never>, { name: string; code: string }[]>('listBanks'),
  resolveAccount: callable<{ bankCode: string; accountNumber: string }, { accountName: string }>('resolveAccount'),
  setPayoutAccount: callable<{ bankCode: string; bankName: string; accountNumber: string }, { ok: true; accountName: string }>('setPayoutAccount'),
  createDues: callable<{ title: string; amountNaira: number; dueDate?: string }, { ok: true; duesId: string }>('createDues'),
  closeDues: callable<{ duesId: string }, { ok: true }>('closeDues'),
  startPayment: callable<{ duesId: string; returnUrl: string }, { authorizationUrl: string; reference: string; totalKobo: number }>('startPayment'),
  verifyPayment: callable<{ reference: string }, { status: string }>('verifyPayment'),
  recordCash: callable<Who & { duesId: string }, { ok: true }>('recordCash'),
  respondCash: callable<{ duesId: string; confirm: boolean }, { ok: true }>('respondCash'),
  remindDues: callable<{ duesId: string }, { ok: true; owing: number; notified: number }>('remindDues'),
};
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
import { connectStorageEmulator, getStorage } from 'firebase/storage';

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FB_API_KEY as string,
  authDomain: env.VITE_FB_AUTH_DOMAIN as string,
  projectId: env.VITE_FB_PROJECT_ID as string,
  storageBucket: env.VITE_FB_STORAGE_BUCKET as string,
  messagingSenderId: env.VITE_FB_MESSAGING_SENDER_ID as string,
  appId: env.VITE_FB_APP_ID as string,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Offline cache: your tag and status still show when there is no data.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const storage = getStorage(app);

/** The CDS Pass API server (Express on Render). */
export const API_URL = ((env.VITE_API_URL as string) || 'http://localhost:8787').replace(/\/$/, '');

if (env.VITE_USE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
  connectStorageEmulator(storage, 'localhost', 9199);
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
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ data }),
      });
    } catch {
      throw Object.assign(new Error('No internet connection.'), { code: 'functions/unavailable' });
    } finally {
      clearTimeout(slow);
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
      return 'This state code is already registered. Log in instead.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
    case 'functions/unavailable':
      return 'No internet connection. Check your data and try again.';
    case 'functions/deadline-exceeded':
      return 'The server did not respond. Please try again in a moment.';
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
 */
export async function compressPhoto(file: File, size = 512, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a photo.');

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that photo. Try another one.'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot process photos.');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process photo.'))), 'image/jpeg', quality),
    );
  } finally {
    URL.revokeObjectURL(url);
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
import { registerServiceWorker } from './sw';
import { toast } from './toast';

export type PushState = 'unsupported' | 'default' | 'granted' | 'denied';

export async function pushState(): Promise<PushState> {
  if (!('Notification' in window) || !(await isSupported())) return 'unsupported';
  return Notification.permission as PushState;
}

/** Asks permission, gets an FCM token and saves it on the member's profile. */
export async function enableNotifications(uid: string): Promise<void> {
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
    vapidKey: import.meta.env.VITE_FB_VAPID_KEY as string,
    serviceWorkerRegistration: reg,
  });
  if (!token) throw new Error('Could not set up notifications. Try again.');
  await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token), updatedAt: serverTimestamp() });
  localStorage.setItem('cdspass:push', 'on');
}

/** When the site is open, show incoming pushes as an in-app toast instead. */
export async function listenForegroundPush() {
  if (!(await isSupported())) return;
  onMessage(getMessaging(app), (payload) => {
    const d = payload.data ?? {};
    navigator.vibrate?.([300, 120, 300]);
    toast(d.title ?? 'CDS Pass', 'success', d.body);
  });
}
```

---

### `web/src/lib/money.ts`

```ts
export const naira = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Same maths as duesCharges on the server: dues + 3% service + Paystack's exact charge, rounded up to the naira. */
const SERVICE_FEE_PERCENT = Number(import.meta.env.VITE_SERVICE_FEE_PERCENT ?? 3);
const PAYSTACK_FEE_PERCENT = Number(import.meta.env.VITE_PAYSTACK_FEE_PERCENT ?? 1.5);

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

function emit() {
  listeners.forEach((l) => l(items));
}

export function toast(title: string, kind: ToastKind = 'info', body?: string) {
  const id = nextId++;
  items = [...items, { id, title, body, kind }].slice(-3);
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 4000);
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
  dueDate: string | null;
  active: boolean;
  createdAt?: Timestamp;
}

/** groups/{gid}/dues/{duesId}/status/{uid} */
export interface DuesStatus {
  uid: string;
  status: 'paid' | 'cash_pending';
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
  nextNumber: number;
  nextPriority: number;
  lastTo: number;
  batchSeq: number;
  batch: Batch | null;
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
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

/** Uploads a compressed profile picture and returns its public URL. */
export async function uploadAvatar(uid: string, blob: Blob): Promise<string> {
  const r = ref(storage, `avatars/${uid}/${Date.now()}.jpg`);
  await uploadBytes(r, blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000' });
  return getDownloadURL(r);
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
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorBox, Field, TopBar } from '../components/ui';
import { auth, errorText } from '../lib/firebase';
import { normalizeStateCode, stateCodeToEmail } from '../lib/rules';

export default function Login() {
  const [stateCode, setStateCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
import { motion } from 'framer-motion';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

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
    <div className="screen bg-green-dark text-white">
      <div className="grid-bg flex flex-1 flex-col items-center px-6 pb-8 pt-[max(2.5rem,env(safe-area-inset-top))] text-center">
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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PhotoPicker } from '../components/PhotoPicker';
import { Button, ErrorBox, Field, TopBar } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { auth, errorText } from '../lib/firebase';
import { normalizePhone, normalizeStateCode, stateCodeToEmail } from '../lib/rules';
import { setSignupLock } from '../lib/signupLock';
import { toast } from '../lib/toast';
import { uploadAvatar } from '../lib/upload';

type Mode = 'join' | 'create';

/** State code is recoverable from the hidden login email (la26b1142@cdspass.app). */
function stateCodeFromCurrentUser(): string {
  const local = auth.currentUser?.email?.split('@')[0] ?? '';
  return normalizeStateCode(local) ?? '';
}

export default function Signup({ finish = false }: { finish?: boolean }) {
  const { refreshClaims, logout } = useAuth();
  const steps = finish ? ['Details', 'Photo', 'CDS group'] : ['Details', 'Photo', 'CDS group', 'PIN'];
  const [rawStep, setStep] = useState(0);
  // If sign-up switches to "finish" mode (fewer steps), never point past the last step.
  const step = Math.min(rawStep, steps.length - 1);
  const [dir, setDir] = useState(1);

  const [stateCode, setStateCode] = useState(finish ? stateCodeFromCurrentUser() : '');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [mode, setMode] = useState<Mode>('join');
  const [joinCode, setJoinCode] = useState('');
  const [group, setGroup] = useState({ name: '', lga: '', state: '' });
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [consent, setConsent] = useState(false);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  function validate(i: number): string {
    if (i === 0) {
      if (!normalizeStateCode(stateCode)) return 'Enter your state code like LA/26B/1142.';
      if (fullName.trim().length < 3) return 'Enter your full name exactly as it is on your NYSC ID card.';
      if (!normalizePhone(phone)) return 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.';
    }
    if (i === 1 && !photo) return 'Add a profile picture.';
    if (i === 2) {
      if (mode === 'join' && joinCode.trim().length !== 6) return 'Enter the 6-character CDS group code from your exco.';
      if (mode === 'create' && (group.name.trim().length < 3 || group.lga.trim().length < 2 || group.state.trim().length < 2))
        return 'Fill in the CDS group name, LGA and state.';
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
    setSignupLock(finish ? 'finish' : 'signup');
    try {
      let uid = auth.currentUser?.uid;
      if (!finish) {
        setBusy('Creating your account…');
        uid = (await createUserWithEmailAndPassword(auth, stateCodeToEmail(sc), pin)).user.uid;
      }
      if (!uid) throw new Error('Please log in again.');

      setBusy('Uploading your photo…');
      const photoURL = await uploadAvatar(uid, photo!);

      setBusy('Saving your details…');
      const profile = { stateCode: sc, fullName: fullName.trim(), phone: normalizePhone(phone)!, photoURL };
      if (mode === 'join') {
        const r = await api.registerMember({ ...profile, joinCode: joinCode.trim().toUpperCase() });
        toast(`Joined ${r.groupName}`, 'success', 'An exco will approve you at your next CDS.');
      } else {
        const r = await api.createGroup({ ...profile, group });
        toast('CDS group created', 'success', `Share this group code with your members: ${r.joinCode}`);
      }
      await refreshClaims();
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    } finally {
      setSignupLock(false);
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
                <PhotoPicker
                  value={photo}
                  onChange={(b, err) => {
                    setPhoto(b);
                    setError(err ?? '');
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
                <div className="grid grid-cols-2 gap-2 rounded-2xl bg-line p-1.5">
                  {(['join', 'create'] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`h-12 rounded-xl text-sm font-bold transition-colors ${mode === m ? 'bg-green text-white shadow-card' : 'text-muted'}`}
                    >
                      {m === 'join' ? 'Join with code' : "I'm an exco"}
                    </button>
                  ))}
                </div>
                {mode === 'join' ? (
                  <Field
                    label="CDS group code"
                    placeholder="K7Q2MX"
                    autoCapitalize="characters"
                    maxLength={6}
                    className="input text-center text-2xl font-extrabold tracking-[0.4em]"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  />
                ) : (
                  <>
                    <Field
                      label="CDS group name"
                      placeholder="Digital Skills CDS"
                      value={group.name}
                      onChange={(e) => setGroup({ ...group, name: e.target.value })}
                    />
                    <Field label="LGA" placeholder="Ikorodu" value={group.lga} onChange={(e) => setGroup({ ...group, lga: e.target.value })} />
                    <Field label="State" placeholder="Lagos" value={group.state} onChange={(e) => setGroup({ ...group, state: e.target.value })} />
                    <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
                      You'll be the first exco of this group and can add other excos later.
                    </p>
                  </>
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
                <label className="flex gap-3 rounded-2xl bg-card p-4 text-sm shadow-card">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 shrink-0 accent-green"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    I agree that my name, state code, phone number and photo are stored by CDS Pass and shown to my
                    CDS excos for attendance only. CDS Pass is an independent tool, not run by NYSC.
                  </span>
                </label>
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
import { lazy, Suspense, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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

  return (
    <div className="screen bg-green-dark text-white lg:max-w-6xl lg:flex-row">
      <div className="grid-bg relative h-[46dvh] min-h-[320px] lg:h-auto lg:w-1/2">
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

        <ul className="mt-6 space-y-4">
          {points.map((p, i) => (
            <motion.li
              key={p.t}
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.15 + i * 0.1 }}
              className="flex gap-3"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-green text-sm font-extrabold text-white">{i + 1}</span>
              <div>
                <p className="font-bold">{p.t}</p>
                <p className="text-sm text-muted">{p.d}</p>
              </div>
            </motion.li>
          ))}
        </ul>

        <div className="mt-auto space-y-3 pt-8 lg:mt-10 lg:max-w-sm">
          <Button onClick={() => nav('/signup')}>Get started</Button>
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
  const lastNumber = (session?.nextNumber ?? 1) - 1;

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
              {batchLabel(batch)}
            </motion.p>
          </AnimatePresence>
          {batch && (
            <p className="relative mt-2 text-sm font-semibold text-green-mid">
              {currentDone} of {inCurrent.length} thumbprinted
            </p>
          )}
        </div>

        {!open && <ErrorBox>Today's meeting is not open.</ErrorBox>}

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
import { useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel, tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function Dashboard() {
  const { me, group, session, attendees, stats, open } = useExcoDay();
  const members = useGroupMembers(me.groupId);
  const pendingCount = members?.filter((m) => m.status === 'pending').length ?? 0;
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
          <Stat value={stats.waiting} label="Waiting" />
        </div>
      </ExcoHeader>

      <Page className="space-y-4">
        <motion.div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold">Today's meeting</p>
              <p className="text-sm text-muted">{open ? 'Open. Members can scan in.' : session ? 'Closed' : 'Not opened yet'}</p>
            </div>
            <Pill tone={open ? 'green' : 'muted'}>{open ? 'Live' : 'Off'}</Pill>
          </div>
          <Button variant={open ? 'outline' : 'primary'} loading={busy} onClick={toggleSession}>
            {open ? 'End meeting' : "Open today's meeting"}
          </Button>
          <ErrorBox>{error}</ErrorBox>
        </motion.div>

        {open && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { to: '/exco/door', icon: 'door', t: 'Door code', d: 'Members scan in' },
              { to: '/exco/call', icon: 'megaphone', t: 'Call batch', d: `Now: ${batchLabel(session?.batch)}` },
              { to: '/exco/table', icon: 'finger', t: 'Table check', d: 'Green or red' },
              { to: '/exco/members', icon: 'users', t: 'Members', d: pendingCount ? `${pendingCount} to approve` : 'All approved' },
            ].map((c) => (
              <Link key={c.to} to={c.to} className="card !p-4 transition active:scale-[0.98]">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-light text-green">
                  <Icon name={c.icon} />
                </span>
                <p className="mt-3 font-bold">{c.t}</p>
                <p className="text-xs text-muted">{c.d}</p>
              </Link>
            ))}
          </div>
        )}

        <Link to="/exco/dues" className="card flex items-center gap-3 !p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-light text-green">
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

function DoorCode() {
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
  }, [refresh]);

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
      const r = await api.excoCheckIn({ uid: found.uid, method: mode === 'scan' ? 'card' : 'manual' });
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
          <p className="text-xs text-muted">Manual check-ins are logged with your name.</p>
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
  const { open, stats } = useExcoDay();
  const [tab, setTab] = useState<Tab>('code');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'code', label: 'Door code' },
    { id: 'scan', label: 'Scan card' },
    { id: 'manual', label: 'State code' },
  ];

  return (
    <>
      <ExcoHeader title="Door check-in" sub={`${stats.present} checked in so far`}>
        <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/10 p-1">
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
          <DoorCode />
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
import { Button, ErrorBox, Field, Icon, Page, Pill, Stat } from '../../components/ui';
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
            <div>
              <label htmlFor="bank" className="label">
                Bank
              </label>
              <select id="bank" className="input" value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
                <option value="">{banks ? 'Choose bank' : 'Loading banks…'}</option>
                {banks?.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    setError('');
    setBusy(true);
    try {
      await api.createDues({ title, amountNaira: Number(amount), dueDate: dueDate || undefined });
      toast('Dues created', 'success', 'Members can pay now.');
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
      <Field label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
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
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const rows = useMemo(() => {
    const byUid = new Map((statuses ?? []).map((s) => [s.uid, s]));
    const approved = (members ?? []).filter((m) => m.status === 'approved');
    const q = search.trim().toLowerCase();
    return approved
      .map((m) => ({ m, s: byUid.get(m.uid) }))
      .filter((r) => !q || r.m.fullName.toLowerCase().includes(q) || r.m.stateCode.toLowerCase().includes(q));
  }, [members, statuses, search]);

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
          <p className="text-sm text-muted">{naira(dues.amountKobo)} per member</p>
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
              <button
                onClick={() =>
                  confirm(`Record ${naira(dues.amountKobo)} cash from ${m.fullName}? They will be asked to confirm it.`) &&
                  run(`cash:${m.uid}`, () => api.recordCash({ uid: m.uid, duesId: dues.id }), 'Cash recorded. Waiting for the member to confirm.')
                }
                disabled={busy === `cash:${m.uid}`}
                className="flex h-10 items-center gap-1.5 rounded-xl bg-green-light px-3 text-sm font-bold text-green disabled:opacity-50"
              >
                <Icon name="cash" size={18} /> Cash
              </button>
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
  const dues = useActiveDues(me.groupId);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <ExcoHeader title="Dues" sub="Online and cash payments" />
      <Page className="space-y-4">
        <PayoutAccount />
        {creating ? (
          <NewDues onDone={() => setCreating(false)} />
        ) : (
          <Button onClick={() => setCreating(true)}>+ New dues</Button>
        )}
        {dues?.map((d) => <DuesDetail key={d.id} dues={d} />)}
        {dues && dues.length === 0 && !creating && <p className="text-center text-sm text-muted">No open dues. Create one above.</p>}
        <p className="text-center text-xs text-muted">
          Cash only counts after the member confirms it on their phone. Every cash record is in the activity log.
        </p>
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
import { Button, ErrorBox, Icon, Page, Pill } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Profile } from '../../lib/types';

type Filter = 'pending' | 'approved' | 'excos';

export default function Members() {
  const me = useMe();
  const members = useGroupMembers(me.groupId);
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
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

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (members ?? [])
      .filter((m) => (filter === 'pending' ? m.status === 'pending' : filter === 'excos' ? m.role === 'exco' : m.status === 'approved'))
      .filter((m) => !q || m.fullName.toLowerCase().includes(q) || m.stateCode.toLowerCase().includes(q));
  }, [members, filter, search]);

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
                {selected.status === 'approved' && selected.uid !== me.uid && (
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
                <input className="input flex-1" placeholder="Search name or state code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
                <button onClick={() => setScanning(true)} aria-label="Scan member code" className="grid h-14 w-14 place-items-center rounded-2xl bg-green text-white">
                  <Icon name="scan" />
                </button>
              </div>

              {members === undefined ? (
                <div className="card h-40 animate-pulse" />
              ) : list.length === 0 ? (
                <div className="card text-center text-sm text-muted">
                  {filter === 'pending' ? 'Nobody is waiting for approval.' : 'No members here yet.'}
                </div>
              ) : (
                <ul className="card divide-y divide-line !p-0">
                  {list.map((m) => (
                    <li key={m.uid}>
                      <button onClick={() => setSelected(m)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                        <Avatar src={m.photoURL} name={m.fullName} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-bold">{m.fullName}</p>
                          <p className="text-xs text-muted">{m.stateCode}</p>
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
import { ThemeToggle } from '../../components/ThemeToggle';
import { Button, ErrorBox, Field, Page, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useLogs } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { getPosition } from '../../lib/device';
import { errorText } from '../../lib/firebase';
import { toast } from '../../lib/toast';

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
                <p className="text-xs text-muted">{l.at?.toDate().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</p>
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
      toast(confirm ? 'Cash payment confirmed' : 'Reported to your excos', confirm ? 'success' : 'info');
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
          {dues.dueDate && (
            <p className="text-sm text-muted">
              Due {new Date(`${dues.dueDate}T12:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
            </p>
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
              {status.method === 'cash' ? 'Cash, confirmed by you' : 'Online'} ·{' '}
              {status.paidAt?.toDate().toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
            </p>
          </div>
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
      <header className="grid-bg relative bg-green-dark px-5 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-8 lg:pt-8">
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
          <Avatar src={me.photoURL} name={me.fullName} size={52} ring />
          <div className="min-w-0">
            <p className="text-sm text-green-mid">{greeting()},</p>
            <p className="truncate text-xl font-extrabold">{me.fullName.split(' ')[0]}</p>
            <p className="text-xs font-semibold text-green-mid">
              {me.stateCode} · {group?.name ?? '…'}
            </p>
          </div>
        </div>
      </header>

      <Page className="relative z-10 -mt-14 space-y-4 lg:!px-6">
        <motion.div className="card flex flex-col items-center gap-3 text-center">
          {!open && !att && (
            <>
              <Pill tone="muted">No meeting open</Pill>
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
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-green font-bold text-white shadow-[0_8px_0_#064726] active:translate-y-[5px] active:shadow-[0_3px_0_#064726]"
              >
                <Icon name="scan" /> Scan in at the door
              </Link>
              {pending && <p className="text-sm font-semibold text-warn">A saved scan will be sent when you're back online.</p>}
            </>
          )}

          {att && (
            <>
              <Pill tone={status === 'turn' ? 'green' : status === 'done' ? 'green' : 'warn'}>
                {status === 'turn' ? "It's your turn" : status === 'done' ? 'Thumbprinted ✓' : 'Checked in'}
              </Pill>
              <span className="text-xs font-bold tracking-[0.3em] text-muted">YOUR NUMBER</span>
              <motion.span
                key={tag}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="text-[88px] font-extrabold leading-none text-green"
                style={{ textShadow: '0 3px 0 rgb(var(--line)), 0 6px 0 rgb(var(--green-light))' }}
              >
                {tag}
              </motion.span>
              <div className="grid w-full grid-cols-2 gap-2">
                <div className="rounded-2xl bg-paper p-3 text-left">
                  <p className="text-xs text-muted">Now calling</p>
                  <p className="font-extrabold">{batchLabel(session?.batch)}</p>
                </div>
                <div className="rounded-2xl bg-paper p-3 text-left">
                  <p className="text-xs text-muted">Ahead of you</p>
                  <p className="font-extrabold">{status === 'waiting' ? `${aheadOf(att, session?.batch)} people` : '—'}</p>
                </div>
              </div>
              <Link to="/tag" className="mt-1 text-sm font-bold text-green">
                Open my tag →
              </Link>
            </>
          )}
        </motion.div>

        {status === 'turn' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex items-center gap-3 rounded-3xl bg-green p-4 text-white shadow-lift"
          >
            <Icon name="finger" size={30} />
            <div>
              <p className="font-extrabold">Go to the thumbprint table now</p>
              <p className="text-sm text-green-mid">Show your tag and your NYSC ID card.</p>
            </div>
          </motion.div>
        )}

        <div className="card space-y-3">
          <p className="font-bold">How it works</p>
          {[
            ['scan', 'Scan the code at the door to get your number.'],
            ['bell', 'Sit down. Your phone buzzes when your batch is called.'],
            ['finger', 'Show your tag at the table, then thumbprint.'],
          ].map(([icon, text]) => (
            <div key={text} className="flex items-center gap-3 text-sm">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-green-light text-green">
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

        {att ? (
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
        ) : (
          <Link to="/scan" className="block rounded-2xl bg-green py-4 text-center font-bold text-white">
            Scan in to get your number
          </Link>
        )}

        <p className={`text-center text-sm ${status === 'turn' ? 'text-white' : 'text-muted'}`}>
          At the table, tap the card to show your QR. The exco scans it and checks your NYSC ID card.
        </p>
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
    void pushState().then(setPush);
  }, []);

  async function turnOnPush() {
    setError('');
    setBusy('push');
    try {
      await enableNotifications(me.uid);
      setPush('granted');
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
          <PhotoPicker value={photo} onChange={(b, err) => (setPhoto(b), setError(err ?? ''))} />
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
                {push === 'granted'
                  ? 'On. Your phone buzzes when your batch is called.'
                  : push === 'denied'
                    ? 'Blocked. Allow notifications in your browser settings.'
                    : push === 'unsupported'
                      ? 'Not available on this browser. Keep CDS Pass open on CDS day.'
                      : 'Get a buzz when it is your turn to thumbprint.'}
              </p>
            </div>
          </div>
          {push !== 'granted' && push !== 'denied' && (
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
        warn: { DEFAULT: v('warn'), bg: v('warn-bg') },
        bad: { DEFAULT: '#B42318', bg: v('bad-bg') },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
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
        // 3D libraries load only on screens that use them.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage'],
        },
      },
    },
  },
});
```
