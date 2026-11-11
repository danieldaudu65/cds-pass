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

/** The group creator is the main exco and owns role assignments and dues creation. */
async function mainExco(req: CallableRequest) {
  const e = await exco(req);
  const group = (await groupRef(e.gid).get()).data();
  if (!group || group.createdBy !== e.uid) {
    throw fail('permission-denied', 'Only the main exco who created this CDS group can do this.');
  }
  return e;
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
  const excos = await db.collection('users').where('groupId', '==', gid).get();
  await notify(
    excos.docs.filter((d) => d.data().status === 'approved' && d.data().role === 'exco').map((d) => d.id),
    'New member needs approval',
    `${p.fullName} (${p.stateCode}) has requested to join your CDS group.`,
    '/exco/members',
    'member-request',
  );
  return { ok: true, status: 'pending', groupName: g.docs[0].data().name };
});

/** An exco creates a new CDS group and becomes its first exco. */
export const createGroup = onCall(async (req : CallableRequest) => {
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
  if (uid === group?.createdBy && role !== 'exco') {
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
  const now = Date.now();
  const w = Math.floor(now / WINDOW_MS);
  return { code: doorCode(secret, e.gid, sid, w), gid: e.gid, sessionId: sid, expiresAt: (w + 1) * WINDOW_MS };
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
export const lookupMember = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const a = await attendeeRef(e.gid, lagosDate(), uid).get();
  return { member: publicMember(uid, user), attendee: a.exists ? a.data() : null };
});

/** Exco checks in someone without a working phone (printed card, or manual by state code). */
export const excoCheckIn = onCall(async (req: CallableRequest) => {
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
export const setPriority = onCall(async (req: CallableRequest) => {
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
export const callNext = onCall(async (req: CallableRequest) => {
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
  const latest = await sessionRef(e.gid, sid).get();
  if (!latest.exists || latest.data()!.status !== 'open' || latest.data()!.batchSeq !== batch.seq) {
    throw fail('failed-precondition', 'The meeting ended before this batch could be called. No alerts were sent.');
  }
  const sent = await notify(targets, `${label}: it's your turn`, 'Go to the thumbprint table now and show your CDS Pass tag.', '/tag', 'batch-call');
  await log(e.gid, e.uid, 'batch_called', { label, notified: sent });
  return { ok: true, batch, notified: sent, inBatch: targets.length };
});

/** Sends a test push only to the signed-in exco's own registered devices. */
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
  await notifyApprovedGroup(
    e.gid,
    `New CDS dues: ${title}`,
    `${naira(Math.round(amount * 100))}${dueDate ? ` · due ${dueDate}` : ''}. Open CDS Pass to view or pay.`,
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
export const respondCash = onCall(async (req: CallableRequest) => {
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
export const remindDues = onCall(async (req: CallableRequest) => {
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
