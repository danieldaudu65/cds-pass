/**
 * CDS Pass API server (Express). Runs on Render; locally with `npm run dev`.
 *
 *   POST /api/<action>      { data }  →  { result }   (same actions the app already uses)
 *   POST /paystack/webhook             Paystack payment events
 *   GET  /health                       for Render and keep-awake pings
 */
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError, type Callable, type RawEndpoint } from './compat';
import * as handlers from './handlers';
import { uploadRouter } from './upload';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: origins, maxAge: 86400 }));

// Profile photos → Cloudinary (multipart upload, so this goes before express.json)
app.use('/upload', uploadRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Paystack needs the exact raw body to check its signature.
app.post('/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const raw = req.body as Buffer;
  const r = req as Request & { rawBody?: Buffer };
  r.rawBody = raw;
  try {
    r.body = JSON.parse(raw.toString('utf8'));
  } catch {
    r.body = {};
  }
  try {
    await (handlers.paystackWebhook as RawEndpoint).handler(r, res);
  } catch (err) {
    console.error('webhook error', err);
    if (!res.headersSent) res.status(500).send('error');
  }
});

app.use(express.json({ limit: '200kb' }));

const STATUS: Record<string, number> = {
  'invalid-argument': 400,
  'failed-precondition': 400,
  'out-of-range': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  aborted: 409,
  'resource-exhausted': 429,
  unimplemented: 501,
  unavailable: 503,
  'deadline-exceeded': 504,
};

const actions = handlers as unknown as Record<string, Callable | RawEndpoint | undefined>;

app.post('/api/:name', async (req: Request, res: Response) => {
  const fn = actions[req.params.name];
  if (!fn || !('__callable' in fn)) {
    res.status(404).json({ error: { status: 'not-found', message: 'Unknown action.' } });
    return;
  }

  let auth: { uid: string; token: Record<string, unknown> } | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const decoded = await getAuth().verifyIdToken(header.slice(7));
      auth = { uid: decoded.uid, token: decoded as unknown as Record<string, unknown> };
    } catch {
      res.status(401).json({ error: { status: 'unauthenticated', message: 'Your login has expired. Please log in again.' } });
      return;
    }
  }

  try {
    const result = await fn.handler({ data: req.body?.data ?? {}, auth, rawRequest: req });
    res.json({ result: result ?? null });
  } catch (e) {
    if (e instanceof HttpsError) {
      res.status(STATUS[e.code] ?? 400).json({ error: { status: e.code, message: e.message } });
      return;
    }
    console.error(`[${req.params.name}]`, e);
    res.status(500).json({ error: { status: 'internal', message: 'Something went wrong on the server. Please try again.' } });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`CDS Pass API listening on :${port}`);
  console.log(`Allowed websites: ${origins.join(', ')}`);
});