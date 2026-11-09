import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

/** Uploads a compressed profile picture and returns its public URL. */
export async function uploadAvatar(uid: string, blob: Blob): Promise<string> {
  const r = ref(storage, `avatars/${uid}/${Date.now()}.jpg`);
  await uploadBytes(r, blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000' });
  return getDownloadURL(r);
}
