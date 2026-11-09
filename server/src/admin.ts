import { cert, getApps, initializeApp } from 'firebase-admin/app';

/**
 * Connects to Firebase.
 * - Live (Render): FIREBASE_SERVICE_ACCOUNT holds the service-account JSON (raw or base64).
 * - Local: no key needed; the *_EMULATOR_HOST variables in dev.env point at the emulators.
 */
export function initAdmin() {
  if (getApps().length) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (sa) {
    const json = JSON.parse(sa.startsWith('{') ? sa : Buffer.from(sa, 'base64').toString('utf8'));
    initializeApp({
      credential: cert(json),
      projectId: json.project_id,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    console.log(`Firebase: connected to project ${json.project_id}`);
  } else {
    const projectId = process.env.GCLOUD_PROJECT || 'demo-cds-pass';
    initializeApp({ projectId });
    console.log(`Firebase: using local emulators for ${projectId}`);
  }
}
