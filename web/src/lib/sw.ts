import { firebaseConfig } from './firebase';

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the one service worker that handles offline cache + notifications. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  if (!('serviceWorker' in navigator)) return (registration = Promise.resolve(null));
  const qs = new URLSearchParams({
    apiKey: firebaseConfig.apiKey ?? '',
    projectId: firebaseConfig.projectId ?? '',
    messagingSenderId: firebaseConfig.messagingSenderId ?? '',
    appId: firebaseConfig.appId ?? '',
  });
  registration = navigator.serviceWorker
    .register(`/firebase-messaging-sw.js?${qs}`, { scope: '/' })
    .catch((e) => {
      console.warn('Service worker failed', e);
      return null;
    });
  return registration;
}
