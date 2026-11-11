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
  testNotification: callable<Record<string, never>, { sent: number; registered: number; members: number }>('testNotification'),
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
