import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FB_API_KEY as string,
  authDomain: env.VITE_FB_AUTH_DOMAIN as string,
  projectId: env.VITE_FB_PROJECT_ID as string,
  storageBucket: env.VITE_FB_STORAGE_BUCKET as string,
  messagingSenderId: env.VITE_FB_MESSAGING_SENDER_ID as string,
  appId: env.VITE_FB_APP_ID as string,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Offline cache: your tag and status still show when there is no data.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

/** The CDS Pass API server (Express on Render). */
export const API_URL = ((env.VITE_API_URL as string) || 'http://localhost:8787').replace(/\/$/, '');

if (env.VITE_USE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
}

let wakeNoticeShown = false;

/**
 * Calls an action on the API server with the member's login token.
 * Errors come back with a `functions/<status>` code so errorText() keeps working.
 */
export function callable<Req = unknown, Res = unknown>(name: string) {
  return async (data: Req): Promise<Res> => {
    const token = await auth.currentUser?.getIdToken();
    // Render's free server sleeps when idle; the first request can take ~50 s to wake it.
    const slow = setTimeout(() => {
      if (wakeNoticeShown) return;
      wakeNoticeShown = true;
      void import('./toast').then(({ toast }) => toast('Server is waking up…', 'info', 'This can take up to a minute the first time. Please wait.'));
    }, 6000);
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ data }),
      });
    } catch {
      throw Object.assign(new Error('No internet connection.'), { code: 'functions/unavailable' });
    } finally {
      clearTimeout(slow);
    }
    const json = (await res.json().catch(() => ({}))) as { result?: Res; error?: { status?: string; message?: string } };
    if (!res.ok) {
      throw Object.assign(new Error(json.error?.message ?? 'Something went wrong. Please try again.'), {
        code: `functions/${json.error?.status ?? 'internal'}`,
      });
    }
    return json.result as Res;
  };
}

/** Turns Firebase errors into a sentence a corps member can understand. */
export function errorText(e: unknown): string {
  const err = e as { code?: string; message?: string };
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong state code or PIN.';
    case 'auth/email-already-in-use':
      return 'This state code is already registered. Log in instead.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
    case 'functions/unavailable':
      return 'No internet connection. Check your data and try again.';
    case 'functions/deadline-exceeded':
      return 'The server did not respond. Please try again in a moment.';
  }
  const msg = err?.message ?? 'Something went wrong.';
  return msg.replace(/^Firebase:\s*/, '').replace(/\s*\(.*\)\.?$/, '');
}