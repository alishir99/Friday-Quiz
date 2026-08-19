/* Pass a request through to the Oracle VM and hand the answer straight back.
 *
 * Why this exists: a corporate filter blocks the whole duckdns.org suffix as
 * "dynamic DNS", so the quiz was unreachable from work machines. The browser
 * now only ever talks to this Pages site, and Cloudflare's edge - which is not
 * behind that filter - does the talking to the VM.
 *
 * ORIGIN is set as an environment variable in the Pages project so the VM's
 * address is not baked into the repository.
 */

const DEFAULT_ORIGIN = 'https://fridayquiz.duckdns.org';

export async function proxy(context) {
  const { request, env } = context;
  const origin = (env && env.ORIGIN) || DEFAULT_ORIGIN;

  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);

  const headers = new Headers(request.headers);
  /* The app decides whether to mark its session cookie Secure from this
     header. The browser reached us over https, so the origin has to be told,
     or the cookie comes back without Secure and the browser drops it. */
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-forwarded-host', incoming.host);
  // Let the origin's certificate match: it was issued for its own name.
  headers.set('host', new URL(origin).host);
  // We want the live feed as a stream, not squashed into a gzip buffer.
  headers.delete('accept-encoding');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual'
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // Required by the spec when the body is a stream. Workers do not insist,
    // but Node does, and it lets the same code be tested outside Cloudflare.
    init.duplex = 'half';
  }

  const res = await fetch(target.toString(), init);

  /* Returned as a stream. /api/events is server-sent events that stays open
     for the whole quiz - reading it to completion first would hang forever and
     nobody would see anything. */
  const out = new Headers(res.headers);
  out.delete('content-encoding');
  out.delete('content-length');
  if (String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
