/**
 * Profile-photo upload (Cloudinary).
 *
 *   POST /upload/avatar    multipart/form-data, field "file"   →  { url }
 *
 * Same idea as BlockHub: the phone sends the photo to OUR server, the server
 * puts it on Cloudinary, and sends back the URL. The app then saves only that
 * URL in Firestore (users/{uid}.photoURL).
 *
 * Only a logged-in person can upload, and each person can only ever write
 * their OWN photo (the Cloudinary file name is their uid), so uploading a new
 * photo replaces the old one instead of piling up files.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const MAX_BYTES = 2 * 1024 * 1024; // photos are compressed to ~50 KB in the browser; 2 MB is plenty

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ error: { message } });

/** Same login check as the /api actions: Firebase ID token in the Authorization header. */
async function requireLogin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return fail(res, 401, 'Please log in again.');
  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7));
    (req as Request & { uid?: string }).uid = decoded.uid;
    next();
  } catch {
    fail(res, 401, 'Your login has expired. Please log in again.');
  }
}

export const uploadRouter = Router();

uploadRouter.post(
  '/avatar',
  requireLogin,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next();
      const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      fail(res, 400, tooBig ? 'That photo is too big. Choose a smaller one.' : 'Could not read the photo.');
    });
  },
  (req: Request, res: Response) => {
    const uid = (req as Request & { uid?: string }).uid!;
    const file = req.file;

    if (!file) return fail(res, 400, 'No photo was sent.');
    if (!file.mimetype.startsWith('image/')) return fail(res, 400, 'Please choose a photo.');
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error('Cloudinary is not configured (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET missing).');
      return fail(res, 500, 'Photo upload is not set up on the server yet.');
    }

    const started = Date.now();
    let answered = false;
    // Never leave the phone waiting: if Cloudinary hasn't answered in 30 s, say so.
    const guard = setTimeout(() => {
      if (answered) return;
      answered = true;
      console.error(`Cloudinary upload timed out after 30s (uid ${uid}, ${file.size} bytes)`);
      fail(res, 504, 'Photo upload is slow right now. Please try again.');
    }, 30_000);

    const stream = cloudinary.uploader.upload_stream(
      {
        timeout: 30_000,
        resource_type: 'image',
        folder: 'cds-pass/avatars',
        public_id: uid, // one photo per person: a new upload replaces the old one
        overwrite: true,
        transformation: [{ width: 512, height: 512, crop: 'limit', quality: 'auto' }],
      },
      (error, result) => {
        clearTimeout(guard);
        if (answered) return;
        answered = true;
        console.log(`avatar upload ${error ? 'FAILED' : 'ok'} in ${Date.now() - started}ms (${file.size} bytes)`);
        if (error || !result) {
          console.error('Cloudinary upload failed:', error);
          return fail(res, 500, 'Could not upload your photo. Please try again.');
        }
        // secure_url contains a version number (…/v1731234567/…), so a replaced photo gets a new URL.
        res.json({ url: result.secure_url });
      },
    );
    stream.end(file.buffer);
  },
);