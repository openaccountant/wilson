// A request the client got wrong: the dashboard server answers it with `status`
// and `message` verbatim. Anything else that escapes a route is a bug or an
// environment fault, so the server logs it and answers a generic 500 instead of
// echoing parser, TypeError or SQLite text.
export class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Parse a request's JSON body without checking its shape; unparseable JSON is a 400. */
export async function jsonValue(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** Parse a request's JSON body that must be a plain object; null, arrays and scalars are a 400 too. */
export async function jsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  const value = await jsonValue(req);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid JSON body');
  }
  return value as T;
}
