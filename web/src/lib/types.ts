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
