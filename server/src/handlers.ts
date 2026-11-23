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

/* ---------------------------------------------------------------------------------------------
 * MULTIPLE CDS GROUPS
 * memberships/{gid}_{uid} is the source of truth for "who is in which CDS, with which role/status".
 * users/{uid} holds the person's profile plus their ACTIVE group (groupId/role/status), and the login
 * claims {gid, role, approved} always match the active group. Switching CDS = switchGroup().
 * Older accounts get their membership created automatically (getMembership / migrateMemberships).
 * ------------------------------------------------------------------------------------------- */

const membershipRef = (gid: string, uid: string) => db.doc(`memberships/${gid}_${uid}`);

function membershipData(gid: string, uid: string, u: FirebaseFirestore.DocumentData, groupName: string, extra: Record<string, unknown> = {}) {
  return {
    gid,
    uid,
    groupName,
    fullName: u.fullName,
    stateCode: u.stateCode,
    phone: u.phone ?? null,
    photoURL: u.photoURL ?? null,
    role: u.role ?? 'member',
    status: u.status ?? 'pending',
    createdAt: u.createdAt ?? FieldValue.serverTimestamp(),
    ...(u.approvedAt ? { approvedAt: u.approvedAt, approvedBy: u.approvedBy ?? null } : {}),
    ...extra,
  };
}

/** A person's membership in a group (created on the fly for accounts from before multiple CDS). */
async function getMembership(gid: string, uid: string): Promise<FirebaseFirestore.DocumentData | null> {
  const m = await membershipRef(gid, uid).get();
  if (m.exists) return m.data()!;
  const u = (await userRef(uid).get()).data();
  if (!u || u.groupId !== gid) return null;
  const g = (await groupRef(gid).get()).data();
  const data = membershipData(gid, uid, u, (g?.name as string) ?? '');
  await membershipRef(gid, uid).set(data);
  return data;
}

/** Everyone in a group (any status). */
async function groupMembers(gid: string) {
  const snap = await db.collection('memberships').where('gid', '==', gid).get();
  return snap.docs.map((d) => d.data() as FirebaseFirestore.DocumentData & { uid: string });
}

/**
 * Change someone's role/status in one group. If that group is the one they are currently using,
 * their profile and login permissions are updated too.
 */
async function updateMembership(gid: string, uid: string, patch: Record<string, unknown>) {
  await membershipRef(gid, uid).set(patch, { merge: true });
  const u = (await userRef(uid).get()).data();
  if (u?.groupId === gid) {
    await userRef(uid).update(patch);
    const m = (await membershipRef(gid, uid).get()).data()!;
    await auth.setCustomUserClaims(uid, { gid, role: m.role, approved: m.status === 'approved' });
  }
}

/** One-time: create memberships for every account made before multiple CDS. Runs at server start. */
export async function migrateMemberships() {
  const flag = db.doc('platform/migrations');
  if ((await flag.get()).data()?.membershipsV1) return;
  const [users, groups] = await Promise.all([db.collection('users').get(), db.collection('groups').get()]);
  const names = new Map<string, string>(groups.docs.map((g): [string, string] => [g.id, String(g.data().name ?? '')]));
  let batch = db.batch();
  let n = 0;
  for (const u of users.docs) {
    const d = u.data();
    if (!d.groupId) continue;
    batch.set(membershipRef(d.groupId, u.id), membershipData(d.groupId, u.id, d, names.get(d.groupId) ?? ''), { merge: true });
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
  await flag.set({ membershipsV1: true, membershipsMigratedAt: FieldValue.serverTimestamp(), count: n }, { merge: true });
  console.log(`[migrate] created/updated ${n} memberships`);
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
  const m = await getMembership(gid, uid);
  if (!m || m.role !== 'exco' || m.status !== 'approved') {
    throw fail('permission-denied', 'Only excos of this CDS group can do this.');
  }
  return { uid, gid, name: m.fullName as string };
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
  const [m, snap] = await Promise.all([getMembership(gid, uid), userRef(uid).get()]);
  const u = snap.data();
  if (!m || !u) throw fail('not-found', 'This person is not in your CDS group.');
  // Profile details + this group's role/status.
  return { uid, user: { ...u, role: m.role, status: m.status } as FirebaseFirestore.DocumentData };
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
  const u = await getMembership(gid, uid);
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
  // Daily push statistics for Admin mode (1 small write per send; never blocks the caller).
  try {
    const withAlerts = new Set(owner.values()).size;
    await db.doc(`platformStats/${lagosDate()}`).set(
      {
        pushPeople: FieldValue.increment(uids.length),
        pushReachable: FieldValue.increment(withAlerts),
        pushDelivered: FieldValue.increment(sent),
        pushFailed: FieldValue.increment(Math.max(0, tokens.length - sent)),
        kinds: { [kind]: FieldValue.increment(1) },
      },
      { merge: true },
    );
  } catch (err) {
    console.error('push stats failed', err);
  }
  return sent;
}

/** Broadcast an event to every approved member of a CDS group. */
async function notifyApprovedGroup(gid: string, title: string, body: string, link = '/home') {
  const recipients = (await groupMembers(gid)).filter((m) => m.status === 'approved').map((m) => m.uid);
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
    const userDoc = {
      ...p,
      groupId: gid,
      role,
      status,
      fcmTokens: [],
      createdAt: FieldValue.serverTimestamp(),
      ...(isMainExco ? { approvedAt: FieldValue.serverTimestamp(), approvedBy: groupData.createdBy } : {}),
    };
    tx.set(userRef(uid), userDoc);
    tx.set(membershipRef(gid, uid), membershipData(gid, uid, userDoc, groupName));
  });
  const role: Role = isMainExco ? 'exco' : 'member';
  const status = isMainExco ? 'approved' : 'pending';
  await auth.setCustomUserClaims(uid, { gid, role, approved: isMainExco });
  await log(gid, uid, 'member_registered', { target: uid, stateCode: p.stateCode });
  if (!isMainExco) {
    const excos = (await groupMembers(gid)).filter((m) => m.status === 'approved' && m.role === 'exco');
    await notify(
      excos.map((m) => m.uid),
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
    const userDoc = {
      ...p,
      groupId: gRef.id,
      role: 'exco',
      status: 'approved',
      fcmTokens: [],
      createdAt: FieldValue.serverTimestamp(),
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: uid,
    };
    tx.create(userRef(uid), userDoc);
    tx.create(membershipRef(gRef.id, uid), membershipData(gRef.id, uid, userDoc, name));
  });
  await auth.setCustomUserClaims(uid, { gid: gRef.id, role: 'exco', approved: true });
  await log(gRef.id, uid, 'group_created', { name });
  return { ok: true, status: 'approved', role: 'exco', groupName: name, joinCode };
});


/**
 * An existing CDS Pass member joins ANOTHER CDS group (e.g. General CDS) with its code.
 * Starts as "pending" for that group's excos to approve (or auto-approved if appointed its main exco).
 * Their current group doesn't change; they switch between groups with switchGroup.
 */
export const joinAnotherGroup = onCall(async (req: CallableRequest) => {
  const { uid } = signedIn(req);
  const joinCode = String(req.data?.joinCode ?? '').trim().toUpperCase();
  if (joinCode.length !== 6) throw fail('invalid-argument', 'Enter the 6-character CDS group code.');
  const u = (await userRef(uid).get()).data();
  if (!u) throw fail('failed-precondition', 'Finish signing up first.');
  const g = await db.collection('groups').where('joinCode', '==', joinCode).limit(1).get();
  if (g.empty) throw fail('not-found', 'No CDS group with that code. Ask its exco for it.');
  const gid = g.docs[0].id;
  const gd = g.docs[0].data();
  if (await getMembership(gid, uid)) throw fail('already-exists', `You are already in ${gd.name}.`);
  if ((await db.collection('memberships').where('uid', '==', uid).get()).size >= 5) {
    throw fail('resource-exhausted', 'You can be in at most 5 CDS groups.');
  }

  let isMainExco = false;
  await db.runTransaction(async (tx) => {
    isMainExco = gd.mainExcoStateCode === u.stateCode && !gd.mainExcoUid;
    if (isMainExco) {
      const resRef = mainExcoReservationRef(u.stateCode);
      const r = await tx.get(resRef);
      if (!r.exists || r.data()!.groupId !== gid || (r.data()!.claimedUid && r.data()!.claimedUid !== uid)) isMainExco = false;
      else {
        tx.update(groupRef(gid), { mainExcoUid: uid, mainExcoClaimedAt: FieldValue.serverTimestamp() });
        tx.update(resRef, { claimedUid: uid, claimedAt: FieldValue.serverTimestamp() });
      }
    }
    tx.set(
      membershipRef(gid, uid),
      membershipData(gid, uid, { ...u, role: isMainExco ? 'exco' : 'member', status: isMainExco ? 'approved' : 'pending', createdAt: null, approvedAt: null }, gd.name, {
        createdAt: FieldValue.serverTimestamp(),
        ...(isMainExco ? { approvedAt: FieldValue.serverTimestamp(), approvedBy: gd.createdBy ?? null } : {}),
      }),
    );
  });
  await log(gid, uid, 'member_registered', { target: uid, stateCode: u.stateCode, label: 'joined as an extra CDS' });
  if (!isMainExco) {
    const excos = (await groupMembers(gid)).filter((m) => m.status === 'approved' && m.role === 'exco');
    await notify(
      excos.map((m) => m.uid),
      'New member needs approval',
      `${u.fullName} (${u.stateCode}) has asked to join ${gd.name}.`,
      '/exco/members',
      'member-request',
    );
  }
  return { ok: true, gid, groupName: gd.name as string, status: isMainExco ? 'approved' : 'pending', role: isMainExco ? 'exco' : 'member' };
});

/** Switch which CDS group the app is showing (and which one your exco powers apply to). */
export const switchGroup = onCall(async (req: CallableRequest) => {
  const { uid } = signedIn(req);
  const gid = String(req.data?.gid ?? '');
  const m = await getMembership(gid, uid);
  if (!m) throw fail('not-found', 'You are not in that CDS group.');
  if (m.status === 'rejected') throw fail('permission-denied', 'That CDS group did not approve your request.');
  await userRef(uid).update({ groupId: gid, role: m.role, status: m.status, switchedAt: FieldValue.serverTimestamp() });
  await auth.setCustomUserClaims(uid, { gid, role: m.role, approved: m.status === 'approved' });
  return { ok: true, gid, groupName: m.groupName as string, role: m.role as Role, status: m.status as string };
});

/** Leave an extra CDS group (not the one you are using right now). */
export const leaveGroup = onCall(async (req: CallableRequest) => {
  const { uid } = signedIn(req);
  const gid = String(req.data?.gid ?? '');
  const u = (await userRef(uid).get()).data();
  if (u?.groupId === gid) throw fail('failed-precondition', 'Switch to another CDS group first, then leave this one.');
  const g = (await groupRef(gid).get()).data();
  if ((g?.mainExcoUid ?? g?.createdBy) === uid) throw fail('failed-precondition', 'The main exco cannot leave their own CDS group.');
  await membershipRef(gid, uid).delete();
  await log(gid, uid, 'member_left', { target: uid, stateCode: u?.stateCode });
  return { ok: true };
});

/** Update your own phone / photo everywhere (profile + every CDS group you're in). */
export const updateMyProfile = onCall(async (req: CallableRequest) => {
  const { uid } = signedIn(req);
  const patch: Record<string, unknown> = {};
  if (req.data?.phone !== undefined) {
    const phone = normalizePhone(req.data.phone);
    if (!phone) throw fail('invalid-argument', 'Enter a valid Nigerian phone number.');
    patch.phone = phone;
  }
  if (req.data?.photoURL !== undefined) {
    const url = req.data.photoURL;
    if (typeof url !== 'string' || !/^https:\/\//.test(url) || url.length > 2000) throw fail('invalid-argument', 'That photo link is not valid.');
    patch.photoURL = url;
  }
  if (!Object.keys(patch).length) throw fail('invalid-argument', 'Nothing to change.');
  const mine = await db.collection('memberships').where('uid', '==', uid).get();
  const batch = db.batch();
  batch.update(userRef(uid), { ...patch, updatedAt: FieldValue.serverTimestamp() });
  mine.docs.forEach((d) => batch.update(d.ref, patch));
  await batch.commit();
  return { ok: true };
});

/** Exco approves (after checking the NYSC ID card) or rejects a pending member. */
export const approveMember = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const { uid, user } = await findMember(e.gid, req.data);
  const approve = req.data?.approve !== false;
  await updateMembership(e.gid, uid, {
    status: approve ? 'approved' : 'rejected',
    approvedBy: e.uid,
    approvedAt: FieldValue.serverTimestamp(),
  });
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
  await updateMembership(e.gid, uid, { role });
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
  const approvedUids = (await groupMembers(e.gid)).filter((m) => m.status === 'approved').map((m) => m.uid);
  const profiles = approvedUids.length ? await db.getAll(...approvedUids.map((u) => userRef(u))) : [];
  const targets = profiles.filter((d) => Array.isArray(d.data()?.fcmTokens) && d.data()!.fcmTokens.length > 0).map((d) => d.id);
  const registered = approvedUids.length;
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

  const all = await groupMembers(e.gid);
  let targets = all.filter((m) => (audience === 'pending' ? m.status === 'pending' : m.status === 'approved'));
  if (audience === 'excos') targets = targets.filter((m) => m.role === 'exco');
  if (audience === 'unpaid') {
    const open = await db.collection(`groups/${e.gid}/dues`).where('active', '==', true).get();
    if (open.empty) throw fail('failed-precondition', 'There are no open dues, so nobody is "not paid".');
    const owing = new Set<string>();
    for (const d of open.docs) (await owingMembers(e.gid, d.id)).forEach((u) => owing.add(u));
    targets = targets.filter((m) => owing.has(m.uid));
  }
  const uids = targets.map((m) => m.uid);
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
    tx.update(aRef, { status: 'done', doneAt: FieldValue.serverTimestamp(), doneBy: e.uid, doneByName: e.name });
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
  const [members, statuses] = await Promise.all([groupMembers(gid), db.collection(`groups/${gid}/dues/${duesId}/status`).get()]);
  const paid = new Set(statuses.docs.filter((s) => s.data().status === 'paid').map((s) => s.id));
  return members.filter((m) => m.status === 'approved' && !paid.has(m.uid)).map((m) => m.uid);
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
  const approvals = new Array(DAYS).fill(0);
  const checkins = new Array(DAYS).fill(0);
  const paidKobo = new Array(DAYS).fill(0);
  const earnedKobo = new Array(DAYS).fill(0);

  const [groupsSnap, usersSnap, membershipsSnap] = await Promise.all([
    db.collection('groups').get(),
    db.collection('users').get(),
    db.collection('memberships').get(),
  ]);
  const memberships = membershipsSnap.docs.map((d) => d.data() as Record<string, any>);
  // Typed loosely on purpose: user docs are plain data here.
  const users: Array<Record<string, any> & { id: string }> = usersSnap.docs.map((d: any) => Object.assign({ id: d.id as string }, d.data()));
  const batchSplit: Record<string, number> = {};
  for (const u of users) {
    const t = u.createdAt?.toMillis?.();
    if (t) {
      const i = idx.get(lagosDate(t));
      if (i !== undefined) signups[i]++;
    }
    const a = u.approvedAt?.toMillis?.();
    if (a) {
      const i = idx.get(lagosDate(a));
      if (i !== undefined) approvals[i]++;
    }
    if (u.status === 'approved') {
      const b = String(u.stateCode ?? '').split('/')[1] ?? '?';
      batchSplit[b] = (batchSplit[b] ?? 0) + 1;
    }
  }
  const hasAlerts = (u: Record<string, any>) => Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0;

  // Push statistics per day (written by notify)
  const statDocs = await db.getAll(...days.map((d) => db.doc(`platformStats/${d}`)));
  const pushPeople = statDocs.map((d) => Number(d.data()?.pushPeople ?? 0));
  const pushDelivered = statDocs.map((d) => Number(d.data()?.pushDelivered ?? 0));
  const pushFailed = statDocs.map((d) => Number(d.data()?.pushFailed ?? 0));
  const pushKinds: Record<string, number> = {};
  for (const d of statDocs) for (const [k, v] of Object.entries((d.data()?.kinds ?? {}) as Record<string, number>)) pushKinds[k] = (pushKinds[k] ?? 0) + Number(v);

  const arrivalHours = new Array(24).fill(0);
  let abandonedPayments = 0;
  const openDues: { group: string; title: string; paid: number; members: number }[] = [];

  const groups: Array<Record<string, any> & { members: number; lastMeeting: string | null }> = [];
  let totalOnlineKobo = 0;
  let totalCashKobo = 0;
  let totalEarnedKobo = 0;
  for (const g of groupsSnap.docs) {
    const gd = g.data();
    // Group membership comes from memberships (people can be in several groups); photos/alerts from profiles.
    const byUid = new Map(users.map((u) => [u.id, u]));
    const mine: Array<Record<string, any>> = memberships.filter((m) => m.gid === g.id).map((m) => Object.assign({}, byUid.get(m.uid) ?? {}, m));
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
    // Last meeting in detail: who got thumbprinted, and when people arrived.
    let lastDone = 0;
    if (lastMeeting) {
      const att = await db.collection(`groups/${g.id}/sessions/${lastMeeting}/attendees`).get();
      for (const a of att.docs) {
        if (a.data().status === 'done') lastDone++;
        const t = a.data().checkedInAt?.toMillis?.();
        if (t) arrivalHours[Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Lagos' })) % 24]++;
      }
    }
    // Online payments started but never finished (older than an hour)
    const pending = await db.collection(`groups/${g.id}/payments`).where('status', '==', 'pending').get();
    abandonedPayments += pending.docs.filter((p) => (p.data().createdAt?.toMillis?.() ?? Date.now()) < Date.now() - 3600_000).length;
    // Open dues: how many have paid
    const dues = await db.collection(`groups/${g.id}/dues`).where('active', '==', true).get();
    for (const d of dues.docs) {
      const paid = (await d.ref.collection('status').where('status', '==', 'paid').count().get()).data().count;
      openDues.push({ group: gd.name, title: d.data().title, paid, members: approved.length });
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
      alertsOn: approved.filter(hasAlerts).length,
      lastDone,
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
      members: new Set(memberships.filter((m) => m.status === 'approved').map((m) => m.uid)).size,
      inSeveralGroups: (() => {
        const c = new Map<string, number>();
        memberships.forEach((m) => c.set(m.uid, (c.get(m.uid) ?? 0) + 1));
        return [...c.values()].filter((n) => n > 1).length;
      })(),
      pending: memberships.filter((m) => m.status === 'pending').length,
      onlineKobo: totalOnlineKobo,
      cashKobo: totalCashKobo,
      earnedKobo: totalEarnedKobo,
      checkins30: checkins.reduce((a, b) => a + b, 0),
      alertsOn: users.filter((u) => u.status === 'approved' && hasAlerts(u)).length,
      noPhoto: users.filter((u) => u.status === 'approved' && !u.photoURL).length,
      abandonedPayments,
    },
    series: { days, signups, approvals, checkins, paidKobo, earnedKobo, pushPeople, pushDelivered, pushFailed },
    pushKinds,
    arrivalHours,
    batchSplit,
    openDues,
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

  // Memberships decide who is in which group; anyone in several groups gets the message once.
  const ms = (await db.collection('memberships').where('status', '==', 'approved').get()).docs.map((d) => d.data());
  const uids: string[] = [
    ...new Set<string>(ms.filter((m) => (!gids.length || gids.includes(m.gid)) && (audience === 'everyone' || m.role === 'exco')).map((m) => m.uid as string)),
  ];
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

/* ======================================================================================
 * CDS STATS for excos (Dashboard): the Admin-style charts, but only for their own group.
 * Cached 5 minutes per group so opening the dashboard doesn't use many database reads.
 * ====================================================================================== */

const groupStatsCache = new Map<string, { at: number; value: unknown }>();

export const groupStats = onCall(async (req: CallableRequest) => {
  const e = await exco(req);
  const hit = groupStatsCache.get(e.gid);
  if (!req.data?.refresh && hit && Date.now() - hit.at < 5 * 60_000) return hit.value;

  const DAYS = 30;
  const days: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) days.push(lagosDate(Date.now() - i * 86_400_000));
  const idx = new Map(days.map((d, i) => [d, i]));
  const joins = new Array(DAYS).fill(0);
  const approvals = new Array(DAYS).fill(0);

  // Members
  const members = await groupMembers(e.gid);
  const approved = members.filter((m) => m.status === 'approved');
  const batchSplit: Record<string, number> = {};
  for (const m of members) {
    const c = m.createdAt?.toMillis?.();
    if (c) {
      const i = idx.get(lagosDate(c));
      if (i !== undefined) joins[i]++;
    }
    const a = m.approvedAt?.toMillis?.();
    if (a) {
      const i = idx.get(lagosDate(a));
      if (i !== undefined) approvals[i]++;
    }
    if (m.status === 'approved') {
      const b = String(m.stateCode ?? '').split('/')[1] ?? '?';
      batchSplit[b] = (batchSplit[b] ?? 0) + 1;
    }
  }
  const profiles = approved.length ? await db.getAll(...approved.map((m) => userRef(m.uid))) : [];
  const alertsOn = profiles.filter((p) => Array.isArray(p.data()?.fcmTokens) && p.data()!.fcmTokens.length > 0).length;

  // Last 8 meetings: checked in vs thumbprinted (count() = 1 read per 1000 people)
  // Meetings from the last ~6 months, oldest first (no special database index needed), keep the last 8.
  const since = lagosDate(Date.now() - 180 * 86_400_000);
  const recent = await db.collection(`groups/${e.gid}/sessions`).where(FieldPath.documentId(), '>=', since).get();
  const lastEight = recent.docs.slice(-8);
  const sessions = { docs: lastEight.slice().reverse() }; // newest first, like before
  const meetings: { date: string; checkedIn: number; done: number }[] = [];
  for (const s of sessions.docs) {
    const col = s.ref.collection('attendees');
    const [all, done] = await Promise.all([col.count().get(), col.where('status', '==', 'done').count().get()]);
    meetings.push({ date: s.id, checkedIn: all.data().count, done: done.data().count });
  }
  meetings.reverse();

  // Arrival times at the last meeting
  const arrivalHours = new Array(24).fill(0);
  if (sessions.docs[0]) {
    const att = await sessions.docs[0].ref.collection('attendees').get();
    for (const a of att.docs) {
      const t = a.data().checkedInAt?.toMillis?.();
      if (t) arrivalHours[Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Lagos' })) % 24]++;
    }
  }

  // Dues: open dues progress + money collected
  const openDues: { title: string; paid: number; members: number; dueDate: string | null }[] = [];
  const dues = await db.collection(`groups/${e.gid}/dues`).where('active', '==', true).get();
  for (const d of dues.docs) {
    const paid = (await d.ref.collection('status').where('status', '==', 'paid').count().get()).data().count;
    openDues.push({ title: d.data().title, paid, members: approved.length, dueDate: d.data().dueDate ?? null });
  }
  const pays = await db.collection(`groups/${e.gid}/payments`).where('status', '==', 'paid').get();
  let onlineKobo = 0;
  let cashKobo = 0;
  const paidKobo = new Array(DAYS).fill(0);
  for (const p of pays.docs) {
    const d = p.data();
    if (d.method === 'cash') cashKobo += d.amountKobo ?? 0;
    else onlineKobo += d.amountKobo ?? 0;
    const t = d.paidAt?.toMillis?.();
    if (t) {
      const i = idx.get(lagosDate(t));
      if (i !== undefined) paidKobo[i] += d.amountKobo ?? 0;
    }
  }

  const value = {
    generatedAt: Date.now(),
    totals: {
      members: approved.length,
      pending: members.filter((m) => m.status === 'pending').length,
      excos: approved.filter((m) => m.role === 'exco').length,
      alertsOn,
      noPhoto: approved.filter((m) => !m.photoURL).length,
      onlineKobo,
      cashKobo,
    },
    days,
    joins,
    approvals,
    paidKobo,
    meetings,
    arrivalHours,
    batchSplit,
    openDues,
  };
  groupStatsCache.set(e.gid, { at: Date.now(), value });
  return value;
});

/**
 * Admin mode: everyone in one CDS group, with details. Phone numbers are shown to the owner and
 * admins only; viewers (e.g. a partner) see them masked.
 */
export const adminGroupMembers = onCall(async (req: CallableRequest) => {
  const me = await platformMember(req, 'viewer');
  const gid = String(req.data?.gid ?? '');
  if (!(await groupRef(gid).get()).exists) throw fail('not-found', 'Group not found.');
  const members = await groupMembers(gid);
  const profiles = members.length ? await db.getAll(...members.map((m) => userRef(m.uid))) : [];
  const alerts = new Map(profiles.map((p) => [p.id, Array.isArray(p.data()?.fcmTokens) && p.data()!.fcmTokens.length > 0]));
  const counts = new Map<string, number>();
  // How many groups each person is in ("in" queries take up to 30 ids at a time).
  for (let i = 0; i < members.length; i += 30) {
    const ids = members.slice(i, i + 30).map((m) => m.uid);
    const all = await db.collection('memberships').where('uid', 'in', ids).get();
    all.docs.forEach((d) => counts.set(d.data().uid, (counts.get(d.data().uid) ?? 0) + 1));
  }
  const canSeePhone = me.role !== 'viewer';
  return {
    members: members
      .map((m) => ({
        uid: m.uid,
        fullName: m.fullName as string,
        stateCode: m.stateCode as string,
        phone: canSeePhone ? ((m.phone as string) ?? '') : String(m.phone ?? '').replace(/\d(?=\d{3})/g, '•'),
        photoURL: (m.photoURL as string) ?? null,
        role: m.role as string,
        status: m.status as string,
        alertsOn: alerts.get(m.uid) ?? false,
        otherGroups: Math.max(0, (counts.get(m.uid) ?? 1) - 1),
        joinedAt: m.createdAt?.toMillis?.() ?? null,
        approvedAt: m.approvedAt?.toMillis?.() ?? null,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
});
