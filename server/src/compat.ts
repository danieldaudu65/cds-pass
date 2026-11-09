/**
 * Tiny stand-ins for the Firebase Functions helpers, so the same handler code
 * runs inside a normal Express server on Render.
 */
export type FunctionsErrorCode =
  | 'ok'
  | 'cancelled'
  | 'unknown'
  | 'invalid-argument'
  | 'deadline-exceeded'
  | 'not-found'
  | 'already-exists'
  | 'permission-denied'
  | 'resource-exhausted'
  | 'failed-precondition'
  | 'aborted'
  | 'out-of-range'
  | 'unimplemented'
  | 'internal'
  | 'unavailable'
  | 'data-loss'
  | 'unauthenticated';

/** An error the member is meant to see, with a status code. */
export class HttpsError extends Error {
  constructor(
    public code: FunctionsErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface CallableRequest<T = any> {
  data: T;
  /** Set when the request carried a valid Firebase login token. */
  auth?: { uid: string; token: Record<string, unknown> };
  rawRequest?: unknown;
}

type CallHandler = (req: CallableRequest) => unknown | Promise<unknown>;
export interface Callable {
  __callable: true;
  handler: CallHandler;
}

/** onCall(handler) or onCall(options, handler) — options are ignored here. */
export function onCall(a: unknown, b?: CallHandler): Callable {
  const handler = (typeof a === 'function' ? a : b) as CallHandler;
  return { __callable: true, handler };
}

type RequestHandler = (req: any, res: any) => unknown | Promise<unknown>;
export interface RawEndpoint {
  __request: true;
  handler: RequestHandler;
}

export function onRequest(a: unknown, b?: RequestHandler): RawEndpoint {
  const handler = (typeof a === 'function' ? a : b) as RequestHandler;
  return { __request: true, handler };
}

export function setGlobalOptions(_opts: unknown) {
  /* not needed on Render */
}

/** Secrets come from environment variables (server/.env locally, Render → Environment live). */
export function defineSecret(name: string) {
  return { value: () => process.env[name] ?? '' };
}
