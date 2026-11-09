# CDS Pass

A web app that ends the queue for numbers at NYSC CDS.

- Corps members **scan in at the door** and get their number in arrival order.
- Excos **call batches** (priority first, then 1–20, 21–40 …) and phones buzz.
- At the thumbprint table the exco scans the member's tag: **green** = their turn, **red** = wait.
- **Dues**: pay online through Paystack, or the treasurer records cash and the member confirms it.
- The LGI's official thumbprint is unchanged. CDS Pass only fixes the queue around it.

> Independent tool for CDS groups. Not affiliated with NYSC. Don't use the NYSC logo.

## How it fits together

| Part | Where it runs | Folder |
|---|---|---|
| Website (React, installable app) | Firebase Hosting | `web/` |
| API server (Express): all anti-cheat rules, dues, Paystack | **Render** (free tier) | `server/` |
| Database, logins, profile photos, notifications | Firebase (Firestore, Auth, Storage, Cloud Messaging) | `firestore.rules`, `storage.rules` |

The old `functions/` folder is no longer used; the same code now lives in `server/src/handlers.ts`.
You can delete `functions/` when you like.

---

## Run it on your PC (development)

You need: Node 20+, Java 21 (for the emulators), `npm install -g firebase-tools`.

**First time only**
```powershell
cd C:\Projects\cds-pass\server
npm install
cd ..\web
npm install
```
`web\.env` must have `VITE_USE_EMULATORS=true`. `VITE_API_URL` defaults to `http://localhost:8787`.

**Every time: three terminals**
```powershell
# 1: Firebase emulators (database, logins, photos)
cd C:\Projects\cds-pass
firebase emulators:start --project demo-cds-pass

# 2: API server
cd C:\Projects\cds-pass\server
npm run dev

# 3: website
cd C:\Projects\cds-pass\web
npm run dev
```
Open <http://localhost:5173>. The emulator dashboard is <http://127.0.0.1:4000>.
Stopping the emulators wipes all test data, so sign up again after each restart.

**Online dues locally:** create `server\keys.env` containing `PAYSTACK_SECRET_KEY=sk_test_...`
(Paystack dashboard → Settings → API Keys & Webhooks), then use `npm run dev:keys` instead of `npm run dev`.

Push notifications don't work on the emulators (they need the real Firebase project). While the app is open,
the phone still buzzes and shows "It's your turn!" when the batch is called.

---

## Go live

### 1. Firebase project (console.firebase.google.com)
1. Create a project (its ID becomes the link: `your-id.web.app`).
2. **Authentication → Email/Password → Enable.**
3. **Firestore Database → Create** (location `europe-west1`, production mode).
4. **Storage → Get started.** New projects need the **Blaze** plan for Storage (free allowance still applies;
   set a $5 budget alert). No card? Ask for photos to be moved to Cloudinary instead.
5. **Project settings → Your apps → Web `</>`** → copy the config into `web\.env`.
6. **Project settings → Cloud Messaging → Web Push certificates → Generate key pair** → `VITE_FB_VAPID_KEY`.
7. **Project settings → Service accounts → Generate new private key** → downloads a JSON file. Keep it secret.

### 2. API server on Render (render.com, free)
1. Put this project on GitHub (private repo).
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml` and creates `cds-pass-api`.
3. Fill in the environment variables Render asks for:
   - `FIREBASE_SERVICE_ACCOUNT`: paste the whole JSON file from step 1.7
   - `FIREBASE_STORAGE_BUCKET`: e.g. `your-id.firebasestorage.app`
   - `CORS_ORIGINS`: `https://your-id.web.app,https://your-id.firebaseapp.com`
   - `PAYSTACK_SECRET_KEY`: test key first, live key later
4. After it deploys, open `https://cds-pass-api.onrender.com/health`. It should show `{"ok":true}`.
5. **Keep it awake on CDS days:** free Render servers sleep after 15 min idle (first request then takes ~50 s).
   Create a free job on <https://cron-job.org> that opens `/health` every 10 minutes.

### 3. Website on Firebase Hosting
In `web\.env` set the real Firebase values, `VITE_USE_EMULATORS=false` and
`VITE_API_URL=https://cds-pass-api.onrender.com`. Then:
```powershell
cd C:\Projects\cds-pass
firebase use --add          # pick your project, alias: default
firebase deploy             # builds the website and uploads it + database/storage rules
```

### 4. After the first deploy
- Paystack → Settings → API Keys & Webhooks → **Webhook URL**: `https://cds-pass-api.onrender.com/paystack/webhook`
- Photos in shared tag images: `gsutil cors set cors.json gs://your-id.firebasestorage.app`
- Test on real phones: install (Android "Install app", iPhone Share → Add to Home Screen), turn on alerts,
  call a batch, pay a dues with a Paystack test card, record and confirm cash.

---

## Dues (online + cash)
**How the money moves:** one Paystack account (yours). Each CDS group's bank account becomes a
Paystack *subaccount*. A member pays dues + 3% service fee + Paystack's exact charge. Paystack sends
the full dues to the group's account and the rest (minus Paystack's own charge) to yours. You never hold group money.

**Cash:** the treasurer taps **Cash** next to a member → the member gets "Confirm your cash payment"
→ it only counts as paid after the member taps **Yes, I paid**. "No, I didn't" removes it and logs a dispute.

Change the charges: `SERVICE_FEE_PERCENT` / `PAYSTACK_FEE_PERCENT` on Render and the matching `VITE_` values in `web\.env`.
Paystack test cards: <https://paystack.com/docs/payments/test-payments>. In test mode, account-name lookup
only works for a few test accounts, so a failed "Checking account…" there is Paystack test mode, not the app.

## How cheating is stopped (all on the server, `server/src/handlers.ts`)

| Trick | What stops it |
|---|---|
| Screenshot of the door QR sent to a friend at home | Code changes every 30 s, signed with a secret only the server knows. Optional venue location check. |
| Getting a number for a friend | One account per state code, one phone login, photo shown at the table, ID card check. |
| Jumping the queue | `tableCheck`: No. 41 is red while 21–40 is called. |
| Thumbprinting twice / reusing a tag | Tag closes after **Done**. |
| Editing your own number from the browser | Firestore rules: only the API server can write numbers, turns and approvals. |
| An exco quietly adding friends | Manual check-ins, priority tags and refusals all go into the activity log, which nobody can edit. |

## Known limits of version 1
- **Offline check-in** is saved and sent when the phone is back online. The number is given when the scan arrives, not when it was made.
- **No SMS alerts yet**: members without data hear the batch read out. Add Termii later.
- **iPhone notifications** only work after "Add to Home Screen". The live screen still updates for everyone.
- **NYSC has no public way to verify a state code**, so every new member is approved by an exco who checks their ID card.
- **Forgot PIN**: an exco resets it (Members → member → Reset PIN) after checking the ID card.
