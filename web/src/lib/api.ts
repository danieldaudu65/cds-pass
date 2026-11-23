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
  adminGroupMembers: callable<{ gid: string }, { members: AdminMemberRow[] }>('adminGroupMembers'),
  adminSetTeamMember: callable<{ stateCode: string; role: 'admin' | 'viewer' | null }, { ok: true }>('adminSetTeamMember'),
  joinAnotherGroup: callable<{ joinCode: string }, { ok: true; gid: string; groupName: string; status: string; role: string }>('joinAnotherGroup'),
  switchGroup: callable<{ gid: string }, { ok: true; gid: string; groupName: string; role: string; status: string }>('switchGroup'),
  leaveGroup: callable<{ gid: string }, { ok: true }>('leaveGroup'),
  updateMyProfile: callable<{ phone?: string; photoURL?: string }, { ok: true }>('updateMyProfile'),
  groupStats: callable<{ refresh?: boolean }, GroupStats>('groupStats'),
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
  alertsOn: number;
  lastDone: number;
  lastMeeting: string | null;
  lastCheckins: number;
  onlineKobo: number;
  cashKobo: number;
  earnedKobo: number;
  createdAt: number | null;
}

export interface AdminOverview {
  generatedAt: number;
  totals: {
    groups: number;
    activeGroups: number;
    members: number;
    pending: number;
    onlineKobo: number;
    cashKobo: number;
    earnedKobo: number;
    checkins30: number;
    alertsOn: number;
    noPhoto: number;
    abandonedPayments: number;
  };
  series: {
    days: string[];
    signups: number[];
    approvals: number[];
    checkins: number[];
    paidKobo: number[];
    earnedKobo: number[];
    pushPeople: number[];
    pushDelivered: number[];
    pushFailed: number[];
  };
  pushKinds: Record<string, number>;
  arrivalHours: number[];
  batchSplit: Record<string, number>;
  openDues: { group: string; title: string; paid: number; members: number }[];
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

export interface GroupStats {
  generatedAt: number;
  totals: { members: number; pending: number; excos: number; alertsOn: number; noPhoto: number; onlineKobo: number; cashKobo: number };
  days: string[];
  joins: number[];
  approvals: number[];
  paidKobo: number[];
  meetings: { date: string; checkedIn: number; done: number }[];
  arrivalHours: number[];
  batchSplit: Record<string, number>;
  openDues: { title: string; paid: number; members: number; dueDate: string | null }[];
}

export interface AdminMemberRow {
  uid: string;
  fullName: string;
  stateCode: string;
  phone: string;
  photoURL: string | null;
  role: string;
  status: string;
  alertsOn: boolean;
  otherGroups: number;
  joinedAt: number | null;
  approvedAt: number | null;
}
