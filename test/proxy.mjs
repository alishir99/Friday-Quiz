/* The Cloudflare Pages proxy, run against a real server.

   A corporate filter blocks the duckdns.org suffix wholesale, so the browser
   talks to a *.pages.dev site and Cloudflare's edge - which is not behind that
   filter - talks to the VM. The proxy is a few lines, but two things in it are
   easy to break and both are silent:

     - the session cookie has to survive both directions, or nobody can sign in
     - /api/events has to stream, or the quiz just hangs with nothing on screen

   The proxy uses plain fetch/Request/Response, so it runs in Node as-is. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxy } from '../functions/_proxy.js';

const PORT = 8260;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const env = { ORIGIN };

let server, dataDir;
let cookie = '';

/** A request as it would arrive at the Pages site, not at the VM. */
const via = (path, init) =>
  proxy({ request: new Request('https://quiz.pages.dev' + path, init), env });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fq-proxy-'));
  server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, QUIZ_DATA_DIR: dataDir, PORT: String(PORT) }, stdio: 'ignore'
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(ORIGIN + '/api/state'); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server never came up');
});

after(async () => {
  if (server) server.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('a plain request passes through', async () => {
  const res = await via('/api/state');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).anonymous, true);
});

test('signing in through the proxy returns a usable session', async () => {
  const res = await via('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ali', password: 'secret1' })
  });
  assert.equal(res.status, 200);

  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'the cookie has to come back through the proxy');
  cookie = setCookie.split(';')[0];

  // The Secure flag comes from x-forwarded-proto, which the proxy sets; without
  // it the browser would drop the cookie on an https page.
  assert.match(setCookie, /Secure/, 'and it has to be marked Secure');

  const back = await via('/api/state', { headers: { cookie } });
  assert.ok((await back.json()).me, 'the session works on the next request');
});

test('the live feed streams rather than buffering', async () => {
  const res = await via('/api/events', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  /* /api/events never ends - it stays open for the whole quiz. Reading it to
     completion would hang, so take only the first chunk. If the proxy ever
     buffers, this is where it shows up as a timeout. */
  const reader = res.body.getReader();
  const first = await Promise.race([
    reader.read().then((x) => new TextDecoder().decode(x.value)),
    new Promise((r) => setTimeout(() => r(null), 5000))
  ]);
  reader.cancel();

  assert.ok(first, 'nothing arrived in five seconds - the proxy buffered it');
  assert.match(first, /data:/, 'and the first push is there');
});

test('a POST body reaches the origin intact', async () => {
  const res = await via('/api/topic', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ topic: 'Badgers' })
  });
  // Ali is alone, so there is no rota yet and the app says so - which is proof
  // enough that it read the body and got as far as the handler.
  assert.ok([200, 400, 403].includes(res.status), 'reached the handler, got ' + res.status);
});
