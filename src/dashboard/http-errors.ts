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

/** Parse a request's JSON body; unparseable JSON is a 400, not an internal error. */
export async function jsonBody<T = unknown>(req: Request): Promise<T> {
  try {
    return await req.json() as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}
