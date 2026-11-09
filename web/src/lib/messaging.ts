import { arrayUnion, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { app, db } from './firebase';
import { registerServiceWorker } from './sw';
import { toast } from './toast';

export type PushState = 'unsupported' | 'default' | 'granted' | 'denied';

export async function pushState(): Promise<PushState> {
  if (!('Notification' in window) || !(await isSupported())) return 'unsupported';
  return Notification.permission as PushState;
}

/** Asks permission, gets an FCM token and saves it on the member's profile. */
export async function enableNotifications(uid: string): Promise<void> {
  if (!(await isSupported())) {
    throw new Error(
      /iPhone|iPad/.test(navigator.userAgent)
        ? 'On iPhone, first tap Share → "Add to Home Screen", then open CDS Pass from there.'
        : 'This browser does not support notifications. Try Chrome.',
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.');

  const reg = await registerServiceWorker();
  if (!reg) throw new Error('Could not set up notifications on this browser.');
  const token = await getToken(getMessaging(app), {
    vapidKey: import.meta.env.VITE_FB_VAPID_KEY as string,
    serviceWorkerRegistration: reg,
  });
  if (!token) throw new Error('Could not set up notifications. Try again.');
  await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token), updatedAt: serverTimestamp() });
  localStorage.setItem('cdspass:push', 'on');
}

/** When the site is open, show incoming pushes as an in-app toast instead. */
export async function listenForegroundPush() {
  if (!(await isSupported())) return;
  onMessage(getMessaging(app), (payload) => {
    const d = payload.data ?? {};
    navigator.vibrate?.([300, 120, 300]);
    toast(d.title ?? 'CDS Pass', 'success', d.body);
  });
}
