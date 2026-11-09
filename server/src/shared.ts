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
