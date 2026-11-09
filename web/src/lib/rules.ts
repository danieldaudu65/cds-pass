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
