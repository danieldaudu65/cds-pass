import { API_URL, auth } from './firebase';

/**
 * Uploads a compressed profile picture to Cloudinary (through our API server)
 * and returns its public URL. Only this URL is saved in the database.
 *
 * Signature is unchanged (uid, blob), so Signup.tsx and Profile.tsx need no edits.
 * The server uses the login token to know who the photo belongs to.
 */
export async function uploadAvatar(_uid: string, blob: Blob): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Please log in again.');

  const form = new FormData();
  form.append('file', blob, 'avatar.jpg');

  let res: Response;
  try {
    res = await fetch(`${API_URL}/upload/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // no Content-Type: the browser sets it for FormData
      body: form,
    });
  } catch {
    throw Object.assign(new Error('No internet connection.'), { code: 'functions/unavailable' });
  }

  const json = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!res.ok || !json.url) {
    throw new Error(json.error?.message ?? 'Could not upload your photo. Please try again.');
  }
  return json.url;
}