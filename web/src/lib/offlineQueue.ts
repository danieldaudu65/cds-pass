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
