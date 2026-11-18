/**
 * Keeps what someone has typed during sign-up, so it survives the phone closing the app.
 *
 * Why: on many Android phones, opening the camera or gallery uses so much memory that the
 * system kills the browser / installed app in the background. When the person comes back the
 * app starts fresh and everything typed was gone, so they were stuck in a loop at the photo step.
 *
 * Stored on this phone only (localStorage), for at most 24 hours, and never the PIN.
 * Cleared when sign-up succeeds or the person logs out.
 */
const KEY = 'cdspass.signupDraft.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SignupDraft {
  step: number;
  stateCode: string;
  fullName: string;
  phone: string;
  joinCode: string;
  startGroup: boolean;
  group: { name: string; lga: string; state: string };
  /** The already-shrunk photo (~50 KB) as a data URL. */
  photo: string | null;
  /** True while the camera/gallery is open; if we start up with this still set, the phone closed the app. */
  pickerOpen: boolean;
  savedAt: number;
}

export function loadDraft(): SignupDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SignupDraft;
    if (!d || typeof d.savedAt !== 'number' || Date.now() - d.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function saveDraft(d: Omit<SignupDraft, 'savedAt'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch {
    // Storage full or blocked (private mode): try again without the photo, else give up quietly.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...d, photo: null, savedAt: Date.now() }));
    } catch {
      /* nothing else we can do */
    }
  }
}

/** Marks the camera/gallery as open (or closed) without touching the rest of the draft. */
export function markPickerOpen(open: boolean) {
  const d = loadDraft();
  if (d) saveDraft({ ...d, pickerOpen: open });
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}
