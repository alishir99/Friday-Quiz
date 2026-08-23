/* Smoke test: boots a real server against a throwaway data directory and
   walks the paths that would be expensive to get wrong - guest join, the
   invite-code perimeter, and who is allowed to inherit next week's quiz.
   Node's own test runner, no dependencies, same as the app itself.

   node --test test/            or      node test/smoke.mjs  */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const INVITE = 'test-invite-code';

let server;
let dataDir;

/** Cookie jars, kept per person so tests can act as each of them. */
const jar = {};

async function call(path, { method = 'GET', body, as } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(as && jar[as] ? { cookie: jar[as] } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && as) jar[as] = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, body: json };
}

const joinAsGuest = (name, as) => call('/api/join', { method: 'POST', body: { name }, as });
const signIn = (name, password, invite, as) =>
  call('/api/login', { method: 'POST', body: { name, password, invite }, as });

const stateAs = (as) => call('/api/state', { as }).then((r) => r.body);

/* Media has to be uploaded before it can be attached: an id that was never
   uploaded now belongs to nobody, which is what stops one team pasting in
   another team's files. */
async function upload(as, bytes = 'not really a jpeg') {
  const res = await fetch(BASE + '/api/media', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-file-name': 'pic.jpg', cookie: jar[as] },
    body: Buffer.from(bytes)
  });
  const body = await res.json().catch(() => ({}));
  return body.media || null;
}
const nameOf = (state, id) => (state.users.find((u) => u.id === id) || {}).name;

/* Step the game on until it reaches a named phase. Tests used to count clicks,
   which meant adding a slide to the running order broke nine of them at once
   and told you nothing about what had actually changed. */
async function advanceTo(phase, as = 'ali', limit = 40) {
  for (let i = 0; i < limit; i++) {
    const s = await stateAs(as);
    if (!s.live) throw new Error('no game is running');
    if (s.live.phase === phase) return s;
    await call('/api/live/advance', { method: 'POST', as });
  }
  throw new Error('never reached phase ' + phase);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fq-smoke-'));
  server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, QUIZ_DATA_DIR: dataDir, QUIZ_INVITE_CODE: INVITE, PORT: String(PORT) },
    stdio: 'ignore'
  });
  // Wait for it to answer rather than guessing at a sleep duration.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/api/state');
      return;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server never came up');
});

after(async () => {
  if (server) server.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('a guest joins with only a nickname', async () => {
  const res = await joinAsGuest('Casual Cal', 'cal');
  assert.equal(res.status, 200);
  assert.ok(res.body.me, 'returns the new user id');

  const state = await stateAs('cal');
  const me = state.users.find((u) => u.id === state.me);
  assert.equal(me.guest, true, 'is flagged as a guest in the state');
});

test('an empty nickname is refused', async () => {
  const res = await joinAsGuest('   ');
  assert.equal(res.status, 400);
});

test('signing up as a member still needs the invite code', async () => {
  const without = await signIn('Ali', 'secret1', undefined, 'ali');
  assert.equal(without.status, 403);
  assert.equal(without.body.needInvite, true);

  const with_ = await signIn('Ali', 'secret1', INVITE, 'ali');
  assert.equal(with_.status, 200);
});

test('a returning member signs in without the invite code', async () => {
  const again = await signIn('Ali', 'secret1', undefined, 'ali');
  assert.equal(again.status, 200);

  const wrong = await signIn('Ali', 'not-the-password', undefined);
  assert.equal(wrong.status, 401);
});

/* The interesting one. A guest record has no password hash, so if /api/login
   could see guests it would fall into its "account predates passwords" branch
   and adopt the account outright - handing it over without ever asking for the
   invite code, because that is only checked for names it has not seen before. */
test('a guest name cannot be used to slip past the invite code', async () => {
  const res = await signIn('Casual Cal', 'hijack1', undefined);
  assert.equal(res.status, 403);
  assert.equal(res.body.needInvite, true);
});

test('a guest cannot take a member’s name, but guests may share one', async () => {
  const clash = await joinAsGuest('ali');           // case-insensitive
  assert.equal(clash.status, 409);

  const first = await joinAsGuest('Sam');
  const second = await joinAsGuest('Sam');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.me, second.body.me, 'each gets their own account');
});

test('a guest cannot become admin', async () => {
  const claim = await call('/api/admin/claim', { method: 'POST', as: 'cal' });
  assert.equal(claim.status, 403);

  // Ali claims it instead, then tries to hand it to a guest.
  assert.equal((await call('/api/admin/claim', { method: 'POST', as: 'ali' })).status, 200);

  const state = await stateAs('ali');
  const guestId = state.users.find((u) => u.guest).id;
  const pass = await call('/api/admin/transfer', { method: 'POST', body: { userId: guestId }, as: 'ali' });
  assert.equal(pass.status, 400);
});

test('the first Friday is seeded from members, never a guest', async () => {
  let state = await stateAs('ali');
  assert.equal(state.upcoming, null, 'one member alone is not enough, guests do not count');

  await signIn('Bea', 'secret1', INVITE, 'bea');
  state = await stateAs('ali');
  assert.ok(state.upcoming, 'two members is enough');
  assert.equal(nameOf(state, state.upcoming.quizMasterId), 'Ali');
  assert.equal(nameOf(state, state.upcoming.topicPickerId), 'Bea');
});

test('a guest cannot be handed next week by hand', async () => {
  const state = await stateAs('ali');
  const guestId = state.users.find((u) => u.guest).id;

  const asAdmin = await call('/api/roles', { method: 'POST', body: { quizMasterId: guestId }, as: 'ali' });
  assert.equal(asAdmin.status, 400);
});

/* The lobby slide is what sits on a shared screen while people file in, so
   the topic has to stay off the wire until the quiz actually starts. */
test('the topic gets a slide of its own before question one', async () => {
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Owls',
      questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0 }],
      tieBreaker: { text: 'n?', unit: '', answer: 1 } } }
  });
  await call('/api/topic', { method: 'POST', body: { topic: 'Owls' }, as: 'ali' });
  await call('/api/live/start', { method: 'POST', as: 'ali' });

  let seen = await stateAs('cal');
  assert.equal(seen.live.phase, 'lobby');
  assert.equal(seen.live.topic, '', 'still a secret while people file in');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });
  seen = await stateAs('cal');
  assert.equal(seen.live.phase, 'topic', 'a slide of its own, not straight to question one');
  assert.equal(seen.live.topic, 'Owls', 'and this is where it is revealed');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });
  assert.equal((await stateAs('cal')).live.phase, 'q', 'then the questions');

  // And back again, so the quiz master can linger on it.
  await call('/api/live/back', { method: 'POST', as: 'ali' });
  assert.equal((await stateAs('ali')).live.phase, 'topic');
  await call('/api/live/back', { method: 'POST', as: 'ali' });
  assert.equal((await stateAs('ali')).live.phase, 'lobby');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

test('the topic stays hidden until the quiz starts', async () => {
  await call('/api/quiz', {
    method: 'PUT',
    as: 'ali',
    body: {
      quiz: {
        topic: 'British seaside towns',
        questions: [{ id: 'q1', text: '2+2?', options: ['3', '4'], correct: 1 }],
        tieBreaker: { text: 'How many?', unit: 'x', answer: 50 }
      }
    }
  });
  await call('/api/topic', { method: 'POST', body: { topic: 'British seaside towns' }, as: 'ali' });
  await call('/api/live/start', { method: 'POST', as: 'ali' });

  const inLobby = await stateAs('cal');
  assert.equal(inLobby.live.phase, 'lobby');
  assert.equal(inLobby.live.topic, '', 'not on the live slide');
  assert.equal(inLobby.upcoming.topic, '', 'and not on the upcoming card either');
  assert.equal(inLobby.upcoming.topicSet, true, 'though everyone can tell one was chosen');

  await advanceTo('q');

  const started = await stateAs('cal');
  assert.equal(started.live.topic, 'British seaside towns', 'revealed once it starts');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });   // leave a clean table
});

/* The scheduled date is written once and then sits there, so a week nobody
   played would show a Friday that had already been and gone. */
test('the quiz is never dated in the past', async () => {
  const state = await stateAs('ali');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayISO = today.toISOString().slice(0, 10);

  assert.ok(state.upcoming.date >= todayISO,
    `showed ${state.upcoming.date}, which is before today (${todayISO})`);
});

/* "Which of these is the badger?" under four photographs is a real question
   with four blank labels, so an option counts as filled once it has media. */
test('an option can be a picture with no words', async () => {
  const media = await upload('ali');
  const media2 = await upload('ali');
  assert.ok(media && media2, 'the quiz maker can upload');
  const saved = await call('/api/quiz', {
    method: 'PUT',
    as: 'ali',
    body: {
      quiz: {
        topic: 'Animals',
        questions: [{
          id: 'q1', text: 'Which one is the badger?',
          options: ['', ''],
          optionMedia: [media, media2],
          correct: 0
        }],
        tieBreaker: { text: 'How many?', unit: '', answer: 4 }
      }
    }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ready, true, 'pictures alone make the question playable');

  // And the media survives the round trip to a player, who gets no answers.
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await call('/api/live/advance', { method: 'POST', as: 'ali' });
  const seen = await stateAs('cal');
  const q = seen.upcoming.quiz.questions[0];
  assert.equal(q.optionMedia.length, 2);
  assert.equal(q.optionMedia[0].kind, 'image', 'kind is rebuilt from the mime type');
  assert.equal(q.correct, undefined, 'without giving the answer away');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* Showing answers question by question must not put the ones still to come on
   the wire - that would hand anyone with devtools the rest of the quiz. */
test('per-question reveal shows one answer, not the whole quiz', async () => {
  await call('/api/quiz', {
    method: 'PUT',
    as: 'ali',
    body: {
      quiz: {
        topic: 'Counting',
        questions: [
          { id: 'q1', text: 'First?', options: ['a', 'b'], correct: 0 },
          { id: 'q2', text: 'Second?', options: ['a', 'b'], correct: 1 },
          { id: 'q3', text: 'Third?', options: ['a', 'b'], correct: 0 }
        ],
        tieBreaker: { text: 'How many?', unit: '', answer: 7 }
      }
    }
  });
  // Set from the dashboard before kick-off, and remembered.
  await call('/api/live/reveal', { method: 'POST', body: { mode: 'each' }, as: 'ali' });
  assert.equal((await stateAs('ali')).revealMode, 'each', 'the switch remembers');

  const notMaster = await call('/api/live/reveal', { method: 'POST', body: { mode: 'end' }, as: 'bea' });
  assert.equal(notMaster.status, 403, 'and only the quiz master may flip it');

  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  let seen = await stateAs('cal');
  assert.equal(seen.live.reveal, 'each');
  assert.equal(seen.live.phase, 'q');
  let qs = seen.upcoming.quiz.questions;
  assert.equal(qs[0].correct, undefined, 'the question being asked keeps its answer');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });        // q0 -> a0
  seen = await stateAs('cal');
  assert.equal(seen.live.phase, 'a');
  qs = seen.upcoming.quiz.questions;
  assert.equal(qs[0].correct, 0, 'the answered one is now public');
  assert.equal(qs[1].correct, undefined, 'the next one is still a secret');
  assert.equal(qs[2].correct, undefined, 'and so is the one after that');
  assert.equal(seen.upcoming.quiz.tieBreaker.answer, undefined, 'tiebreaker too');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });        // a0 -> q1
  seen = await stateAs('cal');
  assert.equal(seen.live.phase, 'q');
  assert.equal(seen.live.index, 1, 'straight on to the next question');
  assert.equal(seen.upcoming.quiz.questions[1].correct, undefined, 'still not given away');

  // Back from a question lands on the previous answer, not the lobby.
  await call('/api/live/back', { method: 'POST', as: 'ali' });
  seen = await stateAs('ali');
  assert.equal(seen.live.phase, 'a');
  assert.equal(seen.live.index, 0);

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
  await call('/api/live/reveal', { method: 'POST', body: { mode: 'end' }, as: 'ali' });
});

test('holding answers to the end keeps every one of them back', async () => {
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');
  await call('/api/live/advance', { method: 'POST', as: 'ali' });        // q0 -> q1

  const seen = await stateAs('cal');
  assert.equal(seen.live.phase, 'q', 'questions run start to finish first');
  assert.equal(seen.live.index, 1);
  assert.ok(seen.upcoming.quiz.questions.every((q) => q.correct === undefined),
    'nothing revealed part-way through');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* The running score may only ever count answers already shown. Counting the
   rest would tell a player how they were doing before the reveal, which is
   precisely what holding answers to the end is for. */
test('the running score never counts ahead of the reveal', async () => {
  await call('/api/quiz', {
    method: 'PUT',
    as: 'ali',
    body: {
      quiz: {
        topic: 'Counting',
        questions: [
          { id: 'q1', text: 'One?', options: ['a', 'b'], correct: 0 },
          { id: 'q2', text: 'Two?', options: ['a', 'b'], correct: 0 },
          { id: 'q3', text: 'Three?', options: ['a', 'b'], correct: 0 }
        ],
        tieBreaker: { text: 'How many?', unit: '', answer: 3 }
      }
    }
  });
  await call('/api/live/reveal', { method: 'POST', body: { mode: 'each' }, as: 'ali' });
  await call('/api/live/start', { method: 'POST', as: 'ali' });

  // Bea answers all three correctly as they come up.
  await advanceTo('q');
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });

  let seen = await stateAs('bea');
  assert.deepEqual(seen.live.myScore, { right: 0, of: 0 },
    'answered but not yet marked, so there is nothing to show');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // a0
  seen = await stateAs('bea');
  assert.deepEqual(seen.live.myScore, { right: 1, of: 1 }, 'one marked, one right');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // q1
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });  // wrong
  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // a1
  seen = await stateAs('bea');
  assert.deepEqual(seen.live.myScore, { right: 1, of: 2 }, 'still one, now out of two');

  // Somebody who never answered is not quietly credited.
  const idle = await stateAs('cal');
  assert.equal(idle.live.myScore.right, 0);

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
  await call('/api/live/reveal', { method: 'POST', body: { mode: 'end' }, as: 'ali' });
});

test('holding answers to the end shows no score until the reveal', async () => {
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });
  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // q1
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });

  const mid = await stateAs('bea');
  assert.equal(mid.live.myScore.of, 0,
    'two right already, but saying so would give the game away');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* The score used to jump straight to its final value the moment the answer
   slides began - so a player looking at answer one already knew how the whole
   night had gone. It has to climb with the reveal, the same as 'each' mode. */
test('holding answers to the end still counts them one at a time', async () => {
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });  // right
  await call('/api/live/advance', { method: 'POST', as: 'ali' });                      // q1
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });  // wrong
  await call('/api/live/advance', { method: 'POST', as: 'ali' });                      // q2
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });  // right

  await advanceTo('gap');
  const gap = await stateAs('bea');
  assert.deepEqual(gap.live.myScore, { right: 0, of: 0 },
    'the answers are coming, but none of them has been shown yet');
  assert.ok(gap.upcoming.quiz.questions.every((q) => q.correct === undefined),
    'and none of them is on the wire either');

  const marks = [];
  for (let i = 0; i < 3; i++) {
    await call('/api/live/advance', { method: 'POST', as: 'ali' });      // a0, a1, a2
    marks.push((await stateAs('bea')).live.myScore);
  }
  assert.deepEqual(marks, [
    { right: 1, of: 1 },
    { right: 1, of: 2 },
    { right: 2, of: 3 }
  ], 'one more marked with every answer slide');

  const midway = await stateAs('bea');
  assert.equal(midway.live.index, 2);
  await call('/api/live/back', { method: 'POST', as: 'ali' });           // back to a1
  const back = await stateAs('bea');
  assert.deepEqual(back.live.myScore, { right: 1, of: 2 }, 'and it counts back down too');
  assert.equal(back.upcoming.quiz.questions[2].correct, undefined,
    'the answer that is no longer on screen goes back off the wire');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* The tiebreaker settles a tie, so a second go after watching the counter
   climb would be a second bite at it. */
test('the tiebreaker takes one guess each', async () => {
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('tb');

  let state = await stateAs('ali');
  assert.equal(state.live.phase, 'tb', 'at the tiebreaker');

  const first = await call('/api/live/tiebreak', { method: 'POST', body: { value: 12 }, as: 'bea' });
  assert.equal(first.status, 200);

  const second = await call('/api/live/tiebreak', { method: 'POST', body: { value: 99 }, as: 'bea' });
  assert.equal(second.status, 409, 'no changing it afterwards');

  const junk = await call('/api/live/tiebreak', { method: 'POST', body: { value: 'banana' }, as: 'cal' });
  assert.equal(junk.status, 400, 'and it has to be a number');

  // The first guess is the one that counts.
  await call('/api/live/advance', { method: 'POST', as: 'ali' });   // tb -> gap
  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* People who signed in early and are sat waiting must be in the room the
   moment it opens. They already hold a live connection, so the join-on-connect
   path never fires for them and the lobby used to insist it was empty. */
test('people already waiting are in the room when it starts', async () => {
  const ac = new AbortController();
  const stream = await fetch(BASE + '/api/events', {
    headers: { cookie: jar.bea },
    signal: ac.signal
  });
  // Start reading so the connection is genuinely established server-side.
  const reader = stream.body.getReader();
  await reader.read();

  await call('/api/live/start', { method: 'POST', as: 'ali' });

  const seen = await stateAs('ali');
  const names = seen.live.players.map((id) => nameOf(seen, id));
  assert.ok(names.includes('Bea'), `Bea was waiting but the room held ${JSON.stringify(names)}`);

  ac.abort();
  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* Every past player used to be dropped into the roster at kick-off, so the
   lobby announced a crowd that was not there - and grew by one for every
   guest who had ever played. */
test('each game starts with an empty room', async () => {
  await call('/api/live/start', { method: 'POST', as: 'ali' });

  const fresh = await stateAs('ali');
  assert.equal(fresh.live.playerCount, 0, 'nobody has turned up yet');
  assert.deepEqual(fresh.live.players, [], 'and the roster is genuinely empty');
  // (No live connections are open in this test file - see the next test for
  //  what happens when somebody is already sitting there waiting.)

  // Answering is one way in; opening the app (SSE) is the other.
  await advanceTo('q');
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });

  const joined = await stateAs('ali');
  assert.deepEqual(joined.live.players.map((id) => nameOf(joined, id)), ['Bea'],
    'only the person who actually answered');
  assert.equal(joined.live.playerCount, 1, 'counted once');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

test('a guest plays and scores, but never inherits the quiz', async () => {
  // Ali is quiz master, so Ali writes it and runs it.
  await call('/api/quiz', {
    method: 'PUT',
    as: 'ali',
    body: {
      quiz: {
        topic: 'Smoke',
        questions: [{ id: 'q1', text: '2+2?', options: ['3', '4'], correct: 1 }],
        tieBreaker: { text: 'How many?', unit: 'x', answer: 50 }
      }
    }
  });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  const wrong = await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'cal' });
  assert.equal(wrong.status, 200, 'a guest can answer');
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });

  // The quiz master cannot route around it either.
  const state = await stateAs('ali');
  const guestId = state.users.find((u) => u.guest).id;
  const override = await call('/api/live/roles', { method: 'POST', body: { quizMasterId: guestId }, as: 'ali' });
  assert.equal(override.status, 400);

  await advanceTo('board');

  const before_ = await stateAs('ali');
  const ranked = before_.live.ranking.map((r) => nameOf(before_, r.userId));
  assert.ok(ranked.includes('Casual Cal'), 'the guest is on the board');

  await call('/api/live/finish', { method: 'POST', as: 'ali' });

  const after_ = await stateAs('ali');
  const master = after_.users.find((u) => u.id === after_.upcoming.quizMasterId);
  assert.equal(master.guest, false, 'next week went to a member, not the guest who came last');
  assert.equal(master.name, 'Bea');
});

/* Removing is a flag, not a delete: the person stops being able to sign in and
   drops out of the rota, but every quiz they played still reads properly. */
test('the admin can remove someone, and put them back', async () => {
  // A spare body to remove, so nothing load-bearing is disturbed.
  await signIn('Spare', 'secret1', INVITE, 'spare');
  const state = await stateAs('ali');
  const spare = state.users.find((u) => u.name === 'Spare');

  const gone = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: spare.id, active: false }, as: 'ali'
  });
  assert.equal(gone.status, 200);

  const after = await stateAs('ali');
  assert.equal(after.users.find((u) => u.id === spare.id).active, false,
    'still listed, so past quizzes keep working');

  // Signed out on the spot, and the password no longer gets them back in.
  const locked = await signIn('Spare', 'secret1', undefined);
  assert.equal(locked.status, 403);

  // A wrong password still reads as a wrong password, so this cannot be used
  // to work out who has been removed.
  const wrongPw = await signIn('Spare', 'nope1234', undefined);
  assert.equal(wrongPw.status, 401);

  const back = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: spare.id, active: true }, as: 'ali'
  });
  assert.equal(back.status, 200);
  assert.equal((await signIn('Spare', 'secret1', undefined)).status, 200, 'and they are back');
});

test('only yourself and the quiz master are un-removable', async () => {
  const state = await stateAs('ali');

  const self = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: state.me, active: false }, as: 'ali'
  });
  assert.equal(self.status, 400, 'not yourself - you would lock yourself out');

  // Ali runs this team, so nobody can take Ali off it either.
  const theBoss = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: state.adminId, active: false }, as: 'ali'
  });
  assert.equal(theBoss.status, 400, 'nor whoever runs the team');

  const notAdmin = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: state.me, active: false }, as: 'bea'
  });
  assert.equal(notAdmin.status, 403, 'and only the quiz master may do any of it');
});

/* Holding next week's duty used to block removal outright, which read as a
   broken button. The job is handed on instead. */
test('removing whoever holds next week hands the job on', async () => {
  await signIn('Temp', 'secret1', INVITE, 'temp');
  let state = await stateAs('ali');
  const temp = state.users.find((u) => u.name === 'Temp');

  // Put Temp down to write next week, then remove them.
  await call('/api/roles', { method: 'POST', body: { quizMasterId: temp.id }, as: 'ali' });
  assert.equal((await stateAs('ali')).upcoming.quizMasterId, temp.id);

  const gone = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: temp.id, active: false }, as: 'ali'
  });
  assert.equal(gone.status, 200, 'removal is allowed');

  state = await stateAs('ali');
  assert.notEqual(state.upcoming.quizMasterId, temp.id, 'the duty moved');
  const now = state.users.find((u) => u.id === state.upcoming.quizMasterId);
  assert.ok(now && now.active !== false, 'and landed on somebody still here');
});

/* The code moved out of the environment and into the database so the admin can
   change it without a trip to the server. */
test('the admin can change the invite code from the app', async () => {
  const seen = await stateAs('ali');
  assert.equal(seen.inviteCode, INVITE, 'members can read it, so anyone can invite');

  const guestView = await stateAs('cal');
  assert.equal(guestView.inviteCode, null,
    'a guest cannot - it is what would turn them into a permanent account');

  const mine = await call('/api/invite', { method: 'POST', body: { code: 'Pickled Onion' }, as: 'ali' });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.inviteCode, 'Pickled Onion');

  // The new one works, in any case, and the old one does not.
  assert.equal((await signIn('Codey', 'secret1', 'pickled onion', 'codey')).status, 200);
  const stale = await signIn('Stale', 'secret1', INVITE);
  assert.equal(stale.status, 403, 'the previous code stops working at once');

  const made = await call('/api/invite', { method: 'POST', as: 'ali' });
  assert.equal(made.status, 200);
  assert.match(made.body.inviteCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/,
    'generated codes avoid the characters people misread');

  const notAdmin = await call('/api/invite', { method: 'POST', body: { code: 'nope' }, as: 'bea' });
  assert.equal(notAdmin.status, 403);

  // Put it back so the tests after this one still know the code.
  await call('/api/invite', { method: 'POST', body: { code: INVITE }, as: 'ali' });
});

/* A name is a name however it is capitalised, and the invite code gets passed
   round by word of mouth so it arrives however the sender felt. A password is
   not in that category and must stay exactly as typed. */
test('names and the invite code ignore case; passwords do not', async () => {
  const asTyped = await signIn('ali', 'secret1', undefined, 'lower');
  assert.equal(asTyped.status, 200);
  assert.equal(asTyped.body.me, (await stateAs('ali')).me, 'same account as "Ali"');

  const shouty = await signIn('ALI', 'secret1', undefined);
  assert.equal(shouty.status, 200, 'and the same again in capitals');

  const padded = await signIn('  aLi  ', 'secret1', undefined);
  assert.equal(padded.status, 200, 'stray spaces forgiven too');

  const wrongCasePw = await signIn('Ali', 'SECRET1', undefined);
  assert.equal(wrongCasePw.status, 401, 'but the password is taken literally');

  const oddCaseInvite = await signIn('Newcomer', 'secret1', INVITE.toUpperCase(), 'newbie');
  assert.equal(oddCaseInvite.status, 200, 'invite code accepted in any case');
});

/* ---------------------------------------------------------------------------
   Teams. Everything above runs inside the one team a fresh install starts
   with; these add a second and prove nothing crosses between them. Kept last
   because they add members, and creating a member mid-suite reseeds the rota.
   --------------------------------------------------------------------------- */

const CODE_B = 'badgers-only';

test('the site admin can make a second team; a quiz master cannot', async () => {
  const nope = await call('/api/teams', { method: 'POST', body: { name: 'Badgers' }, as: 'bea' });
  assert.equal(nope.status, 403, 'being a quiz master is not being the site admin');

  const made = await call('/api/teams', { method: 'POST', body: { name: 'Badgers', code: CODE_B }, as: 'ali' });
  assert.equal(made.status, 200);
  assert.equal(made.body.team.name, 'Badgers');

  const list = await call('/api/teams', { as: 'ali' });
  assert.equal(list.status, 200);
  assert.equal(list.body.teams.length, 2);

  const hidden = await call('/api/teams', { as: 'bea' });
  assert.equal(hidden.status, 403, 'other teams are not a quiz master’s business');
});

test('the same name can exist on both teams', async () => {
  // "Ali" is already on team one. The code is what says which is meant.
  const other = await signIn('Ali', 'different1', CODE_B, 'aliB');
  assert.equal(other.status, 200, 'a second Ali, on the other team');

  const one = await stateAs('ali');
  const two = await stateAs('aliB');
  assert.notEqual(one.me, two.me, 'two separate accounts');
  assert.notEqual(one.team.id, two.team.id, 'on two separate teams');

  // And each password only works for its own.
  assert.equal((await signIn('Ali', 'different1', undefined)).status, 409,
    'ambiguous without a code, rather than guessing');
});

test('a team sees only its own members, history and rota', async () => {
  await signIn('Bo', 'secret1', CODE_B, 'bo');

  const a = await stateAs('ali');
  const b = await stateAs('aliB');

  const namesA = a.users.map((u) => u.name);
  const namesB = b.users.map((u) => u.name);
  assert.ok(namesB.includes('Bo'), 'Bo is on team two');
  assert.ok(!namesA.includes('Bo'), 'and nowhere near team one');
  assert.ok(!namesB.includes('Bea'), 'team one’s members stay on team one');

  assert.notDeepEqual(a.history, b.history, 'separate histories');
  assert.equal(b.history.length, 0, 'a new team starts with nothing played');
  assert.notEqual(a.adminId, b.adminId, 'each team has its own quiz master');
});

test('a live game does not leak to the other team', async () => {
  /* Earlier games rotated the duty away from Ali, so take it back first -
     otherwise the writes below quietly 403 and this passes for the wrong
     reason, with the other team seeing no game because there is none. */
  const me = (await stateAs('ali')).me;
  await call('/api/roles', { method: 'POST', body: { quizMasterId: me }, as: 'ali' });

  const wrote = await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Secret', questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0 }],
      tieBreaker: { text: 'n?', unit: '', answer: 1 } } }
  });
  assert.equal(wrote.status, 200, 'the quiz was actually written');
  const started = await call('/api/live/start', { method: 'POST', as: 'ali' });
  assert.equal(started.status, 200, 'and the game actually started');

  const a = await stateAs('ali');
  const b = await stateAs('aliB');
  assert.ok(a.live, 'team one is playing');
  assert.equal(b.live, null, 'team two is not, and cannot tell that anyone is');

  // Nor can the other team drive it.
  const meddle = await call('/api/live/advance', { method: 'POST', as: 'aliB' });
  assert.equal(meddle.status, 403);

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

test('a past quiz cannot be fetched by id from another team', async () => {
  const a = await stateAs('ali');
  assert.ok(a.history.length, 'team one has played');
  const theirs = a.history[0].id;

  assert.equal((await call('/api/history/' + theirs + '/quiz', { as: 'ali' })).status, 200);
  assert.equal((await call('/api/history/' + theirs + '/quiz', { as: 'aliB' })).status, 404,
    'the id is real, but not theirs');
});

test('media cannot be borrowed from another team', async () => {
  const mine = await upload('aliB');
  assert.ok(mine, 'team two can upload for its own quiz');

  // Attaching it to team one's quiz must not stick. (Ali took the duty back
  // in the test above, so this write is allowed to land.)
  const saved = await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Borrowed',
      questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0, media: mine }],
      tieBreaker: { text: 'n?', unit: '', answer: 1 } } }
  });
  assert.equal(saved.status, 200);
  const back = await stateAs('ali');
  assert.equal(back.upcoming.quiz.questions[0].media, null, 'stripped on the way in');

  // And it cannot simply be read over HTTP either.
  const url = '/media/' + mine.id + '.jpg';
  const asOwner = await fetch(BASE + url, { headers: { cookie: jar.aliB } });
  assert.equal(asOwner.status, 200, 'its own team can see it');
  const asOther = await fetch(BASE + url, { headers: { cookie: jar.ali } });
  assert.equal(asOther.status, 404, 'nobody else can');
  const signedOut = await fetch(BASE + url);
  assert.equal(signedOut.status, 404, 'and neither can a stranger');
});

test('a quiz master cannot reach into the other team', async () => {
  const b = await stateAs('aliB');
  const victim = b.users.find((u) => u.name === 'Bo');

  for (const [path, body] of [
    ['/api/reset-password', { userId: victim.id }],
    ['/api/admin/set-active', { userId: victim.id, active: false }],
    ['/api/roles', { quizMasterId: victim.id }]
  ]) {
    const res = await call(path, { method: 'POST', body, as: 'ali' });
    assert.ok(res.status >= 400, path + ' must refuse a stranger from another team');
  }

  // Team two is untouched by any of it.
  const after = await stateAs('aliB');
  assert.equal(after.users.find((u) => u.id === victim.id).active, true);
});

test('a team can be renamed, and a code says whose team it is', async () => {
  /* A team the site admin made has nobody running it until someone claims it,
     the same way the very first team works. */
  assert.equal((await call('/api/admin/claim', { method: 'POST', as: 'aliB' })).status, 200);

  const before = await stateAs('aliB');
  const renamed = await call('/api/teams/name', { method: 'POST', body: { name: 'The Badgers' }, as: 'aliB' });
  assert.equal(renamed.status, 200);
  assert.equal((await stateAs('aliB')).team.name, 'The Badgers');
  assert.equal((await stateAs('ali')).team.name, before.team.name === 'The Badgers' ? before.team.name : 'Friday Quiz',
    'the other team is untouched');

  // Someone who is not the quiz master cannot rename it.
  const nope = await call('/api/teams/name', { method: 'POST', body: { name: 'Hijacked' }, as: 'bo' });
  assert.equal(nope.status, 403);

  // And a code tells you whose quiz you are about to join, before signing in.
  const known = await call('/api/team-for-code', { method: 'POST', body: { code: CODE_B } });
  assert.equal(known.body.name, 'The Badgers', 'answered without being signed in');

  const unknown = await call('/api/team-for-code', { method: 'POST', body: { code: 'not-a-real-code' } });
  assert.equal(unknown.body.name, null, 'and gives nothing away for a wrong code');
});

test('the topic picker can be removed too, and the job moves', async () => {
  const b = await stateAs('aliB');
  const picker = b.upcoming && b.upcoming.topicPickerId;
  assert.ok(picker, 'team two has a rota');
  assert.notEqual(picker, b.adminId, 'and the picker is not the one running it');

  const res = await call('/api/admin/set-active', {
    method: 'POST', body: { userId: picker, active: false }, as: 'aliB'
  });
  assert.equal(res.status, 200, 'no longer refused');
  assert.notEqual((await stateAs('aliB')).upcoming.topicPickerId, picker, 'handed on');
});

/* With only two playing, "second from last" is whoever won - so the wooden
   spoon used to take the quiz and hand the topic to the person who had just
   beaten them. The winner never gets a job. */
test('the winner is never handed next week', async () => {
  const state = await stateAs('ali');

  /* Ali runs it, so does not rank. Bea and Newcomer play - both members, since
     a guest would be filtered out of the rota and leave only one candidate. */
  await call('/api/roles', { method: 'POST', body: { quizMasterId: state.me }, as: 'ali' });
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Pair',
      questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0 }],
      tieBreaker: { text: 'n?', unit: '', answer: 1 } } }
  });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });     // right
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'newbie' });  // wrong
  await advanceTo('board');

  const before = await stateAs('ali');
  const ranked = before.live.ranking.filter((r) => {
    const u = before.users.find((x) => x.id === r.userId);
    return u && !u.guest && u.active !== false;      // only the rota-eligible
  });
  assert.equal(ranked.length, 2, 'exactly two eligible players ranked');
  const winner = ranked[0].userId;

  await call('/api/live/finish', { method: 'POST', as: 'ali' });
  const after = await stateAs('ali');
  assert.notEqual(after.upcoming.topicPickerId, winner, 'the winner does not pick the topic');
  assert.notEqual(after.upcoming.quizMasterId, winner, 'nor write the quiz');
});

/* Running the install is a different job from running a team. Somebody handed
   a code for a new team must not be able to take the whole place. */
test('a new team cannot claim the site', async () => {
  const owner = await stateAs('ali');
  assert.equal(owner.siteAdmin, true, 'Ali owns the install');

  const made = await call('/api/teams', {
    method: 'POST', body: { name: 'Latecomers', code: 'late-code' }, as: 'ali'
  });
  assert.equal(made.status, 200);

  // First person on that team claims it - they get the team, not the install.
  await signIn('Newbie', 'secret1', 'late-code', 'late');
  const claim = await call('/api/admin/claim', { method: 'POST', as: 'late' });
  assert.equal(claim.status, 200, 'they do become their own quiz master');

  const theirs = await stateAs('late');
  assert.equal(theirs.adminId, theirs.me, 'quiz master of their team');
  assert.equal(theirs.siteAdmin, false, 'but not of the install');

  assert.equal((await call('/api/teams', { as: 'late' })).status, 403,
    'and still cannot see the other teams');
  assert.equal((await stateAs('ali')).siteAdmin, true, 'Ali still owns it');
});

/* Passing a team on and handing over the server are different things, and the
   difference matters: one is weekly housekeeping, the other gives somebody the
   whole install. */
test('handing on a team is not handing on the server', async () => {
  const before = await stateAs('ali');
  assert.equal(before.siteAdmin, true);
  assert.equal(before.adminId, before.me, 'Ali runs this team too');

  const bea = before.users.find((u) => u.name === 'Bea');
  assert.equal((await call('/api/admin/transfer', {
    method: 'POST', body: { userId: bea.id }, as: 'ali'
  })).status, 200);

  const after = await stateAs('ali');
  assert.equal(after.adminId, bea.id, 'Bea runs the team now');
  assert.equal(after.siteAdmin, true, 'but Ali still runs the server');
  assert.equal((await call('/api/teams', { as: 'ali' })).status, 200, 'and can still see every team');
  assert.equal((await stateAs('bea')).siteAdmin, false, 'Bea did not inherit the server');

  // Put it back, since later assertions expect Ali to run this team.
  await call('/api/admin/transfer', { method: 'POST', body: { userId: before.me }, as: 'bea' });
});

test('the server itself can be handed on, by its owner only', async () => {
  const start = await stateAs('ali');
  const bea = start.users.find((u) => u.name === 'Bea');

  assert.equal((await call('/api/site-admin/transfer', {
    method: 'POST', body: { userId: start.me }, as: 'bea'
  })).status, 403, 'not by somebody who does not own it');

  assert.equal((await call('/api/site-admin/transfer', {
    method: 'POST', body: { userId: bea.id }, as: 'ali'
  })).status, 200);

  assert.equal((await stateAs('bea')).siteAdmin, true, 'Bea owns the server now');
  assert.equal((await stateAs('ali')).siteAdmin, false, 'and Ali no longer does');
  assert.equal((await call('/api/teams', { as: 'ali' })).status, 403, 'nor sees the other teams');

  // Hand it back so the rest of the suite runs as before.
  await call('/api/site-admin/transfer', { method: 'POST', body: { userId: start.me }, as: 'bea' });
  assert.equal((await stateAs('ali')).siteAdmin, true);
});

/* The two layout overrides. They reach players as well as the big screen, since
   the phone lays the answers out too - and a bad value must not get through. */
test('picture size and answer layout are saved and sent on', async () => {
  // Earlier games moved the duty on, so take it back before writing a quiz.
  const me = (await stateAs('ali')).me;
  await call('/api/roles', { method: 'POST', body: { quizMasterId: me }, as: 'ali' });

  const saved = await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Layout',
      questions: [
        { id: 'q1', text: 'A?', options: ['a', 'b'], correct: 0,
          mediaSize: 57, optionLayout: 'row' },
        { id: 'q2', text: 'B?', options: ['a', 'b'], correct: 0,
          mediaSize: 'enormous', optionLayout: 'diagonal' },  // nonsense
        // Written before the size was a number, and must not change shape.
        { id: 'q3', text: 'C?', options: ['a', 'b'], correct: 0, mediaSize: 'fill' },
        { id: 'q4', text: 'D?', options: ['a', 'b'], correct: 0, mediaSize: 4000 },
        // Pictures inside the options are sized separately from the question's.
        { id: 'q5', text: 'E?', options: ['a', 'b'], correct: 0, optionPicSize: 30 },
        { id: 'q6', text: 'F?', options: ['a', 'b'], correct: 0, optionPicSize: 'huge' }
      ],
      tieBreaker: { text: 'n?', unit: '', answer: 1 } } }
  });
  assert.equal(saved.status, 200);

  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');
  const seen = await stateAs('cal');
  const qs = seen.upcoming.quiz.questions;

  assert.equal(qs[0].mediaSize, 57, 'the size the quiz maker dragged to survives');
  assert.equal(qs[0].optionLayout, 'row');
  assert.equal(qs[1].mediaSize, 42, 'nonsense falls back to the default');
  assert.equal(qs[1].optionLayout, 'auto');
  assert.equal(qs[2].mediaSize, 86, 'an old "fill" still means what it meant');
  assert.equal(qs[3].mediaSize, 90, 'and a silly number is clamped, not obeyed');
  assert.equal(qs[4].optionPicSize, 30, 'option pictures carry their own size');
  assert.equal(qs[5].optionPicSize, 18, 'falling back to the default when it is nonsense');
  assert.equal(qs[0].optionPicSize, 18, 'and a question that never set one still has it');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});


/* Stepping back to a question is a kindness when somebody missed it, and a
   loophole once its answer has been on the board. Both go through the same
   Back button, so the difference has to live in what may still be answered. */
test('going back reopens a question, unless it has already been marked', async () => {
  const state = await stateAs('ali');
  await call('/api/roles', { method: 'POST', body: { quizMasterId: state.me }, as: 'ali' });
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Second chances',
      questions: [
        { id: 'q1', text: 'One?', options: ['a', 'b'], correct: 0 },
        { id: 'q2', text: 'Two?', options: ['a', 'b'], correct: 0 }
      ],
      tieBreaker: { text: 'n?', unit: '', answer: 10 } } }
  });
  await call('/api/live/reveal', { method: 'POST', body: { mode: 'each' }, as: 'ali' });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });   // wrong

  // Nobody has been marked yet, so a step back is just another look at it.
  await call('/api/live/advance', { method: 'POST', as: 'ali' });   // q0 -> a0
  await call('/api/live/back', { method: 'POST', as: 'ali' });      // a0 -> q0, answer seen

  const late = await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });
  assert.equal(late.status, 409, 'no second go once the answer has been shown');
  assert.match(late.body.error, /already been shown/);

  const held = await stateAs('bea');
  assert.equal(held.live.myAnswers[0], 1, 'the answer given at the time is the one that stands');
  assert.equal(held.live.shown, 0, 'and the phone is told the question is closed');

  // The question the room has not been marked on is still open, though.
  await advanceTo('q', 'ali');
  const s2 = await stateAs('ali');
  assert.equal(s2.live.index, 0, 'still on the first question');
  await call('/api/live/advance', { method: 'POST', as: 'ali' });   // -> a0
  await call('/api/live/advance', { method: 'POST', as: 'ali' });   // -> q1
  const open = await stateAs('bea');
  assert.equal(open.live.index, 1);
  assert.ok(open.live.index > open.live.shown, 'question two has not been marked');
  assert.equal((await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' })).status,
    200, 'so it takes answers as normal');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
  await call('/api/live/reveal', { method: 'POST', body: { mode: 'end' }, as: 'ali' });
});

/* Holding the answers to the end means nothing has been revealed during the
   question run, so the shown-answer wall never fires there. Stepping back
   still has to close the question, or it can be revised at leisure while the
   quiz maker re-reads it to the room. */
test('holding answers to the end still closes a question once it is past', async () => {
  const state = await stateAs('ali');
  await call('/api/roles', { method: 'POST', body: { quizMasterId: state.me }, as: 'ali' });
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'No going back',
      questions: [
        { id: 'q1', text: 'One?', options: ['a', 'b'], correct: 0 },
        { id: 'q2', text: 'Two?', options: ['a', 'b'], correct: 0 }
      ],
      tieBreaker: { text: 'n?', unit: '', answer: 10 } } }
  });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });   // committed
  // Newcomer misses it entirely.
  await call('/api/live/advance', { method: 'POST', as: 'ali' });                       // q0 -> q1
  await call('/api/live/back', { method: 'POST', as: 'ali' });                          // back to q0

  const seen = await stateAs('bea');
  assert.equal(seen.live.index, 0, 'back on the first question');
  assert.equal(seen.live.shown, -1, 'with nothing revealed - this is end mode');
  assert.equal(seen.live.asked, 1, 'but the quiz has been past it');

  const rethink = await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });
  assert.equal(rethink.status, 409, 'no revising it now');
  assert.match(rethink.body.error, /moved on/);
  assert.equal((await stateAs('bea')).live.myAnswers[0], 1, 'the answer given at the time stands');

  // Whoever never answered can still catch up - usually why the quiz maker went back.
  const catchUp = await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'newbie' });
  assert.equal(catchUp.status, 200, 'a first answer is still allowed');
  assert.equal((await stateAs('newbie')).live.myAnswers[0], 0);

  // And having caught up, they are locked to it like everyone else.
  assert.equal((await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'newbie' })).status,
    409, 'one go each, once the quiz has moved on');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* A <video> or <audio> element asks for byte ranges, and a player told nothing
   about them has to fetch the whole clip before it will let anybody scrub -
   which for a clip of any size means the scrubber on the stage does nothing. */
test('media is served in byte ranges, so a clip can be scrubbed', async () => {
  const me = (await stateAs('ali')).me;
  await call('/api/roles', { method: 'POST', body: { quizMasterId: me }, as: 'ali' });
  const media = await upload('ali', 'abcdefghijklmnopqrstuvwxyz');
  assert.ok(media, 'uploaded');
  const url = `/media/${media.id}.jpg`;

  const whole = await fetch(BASE + url, { headers: { cookie: jar.ali } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes', 'and says so');
  assert.equal(await whole.text(), 'abcdefghijklmnopqrstuvwxyz');

  const part = await fetch(BASE + url, { headers: { cookie: jar.ali, range: 'bytes=3-7' } });
  assert.equal(part.status, 206, 'a range gets partial content');
  assert.equal(part.headers.get('content-range'), 'bytes 3-7/26');
  assert.equal(await part.text(), 'defgh', 'and exactly those bytes');

  // Open-ended, which is what a media element actually sends first.
  const open = await fetch(BASE + url, { headers: { cookie: jar.ali, range: 'bytes=20-' } });
  assert.equal(open.status, 206);
  assert.equal(await open.text(), 'uvwxyz');

  // A suffix range, and one that runs past the end.
  const tail = await fetch(BASE + url, { headers: { cookie: jar.ali, range: 'bytes=-4' } });
  assert.equal(await tail.text(), 'wxyz', 'the last four bytes');
  const over = await fetch(BASE + url, { headers: { cookie: jar.ali, range: 'bytes=20-999' } });
  assert.equal(over.status, 206);
  assert.equal(over.headers.get('content-range'), 'bytes 20-25/26', 'clamped to the end');

  const silly = await fetch(BASE + url, { headers: { cookie: jar.ali, range: 'bytes=999-' } });
  assert.equal(silly.status, 416, 'past the end is not satisfiable');
});

/* Fetching a picture from a URL means the server makes a request somebody else
   chose, which is a forgery hole if it is left open: the box would happily
   fetch its own cloud credentials off the link-local metadata address and file
   them under this week's quiz. It runs on a VM where that address answers. */
test('a picture can be pulled from a link, but not from anywhere', async () => {
  // Only the quiz maker may ask, so make sure that is who is asking.
  const me = (await stateAs('ali')).me;
  await call('/api/roles', { method: 'POST', body: { quizMasterId: me }, as: 'ali' });

  const from = (url, as = 'ali') =>
    call('/api/media/from-url', { method: 'POST', body: { url }, as });

  // Only the quiz maker, like an upload.
  assert.equal((await from('http://example.com/x.png', 'bea')).status, 403,
    'a player cannot make the server fetch things');

  for (const [url, why] of [
    ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata service'],
    ['http://127.0.0.1:8123/api/state', 'the server talking to itself'],
    ['http://localhost:8123/api/state', 'the same by name'],
    ['http://10.0.0.5/secret', 'a private network'],
    ['http://192.168.1.1/', 'the router'],
    ['http://[::1]/', 'loopback in v6']
  ]) {
    const r = await from(url);
    assert.equal(r.status, 400, why + ' must be refused: ' + url);
    assert.match(r.body.error, /will fetch|does not resolve/, why);
  }

  assert.equal((await from('file:///etc/passwd')).status, 400, 'no file://');
  assert.equal((await from('ftp://example.com/x.png')).status, 400, 'no ftp://');
  assert.equal((await from('not a url')).status, 400, 'and not nonsense');
  assert.equal((await from('')).status, 400, 'nor nothing at all');

  // The commonest paste of all gets told what to do instead of a vague failure.
  const search = await from('https://www.google.com/search?q=elephant&udm=2');
  assert.equal(search.status, 400);
  assert.match(search.body.error, /search results page/, 'says so plainly');
  assert.match(search.body.error, /copy the image address/, 'and what to do instead');
});

/* The wooden spoon writes next Friday's quiz and whoever finished just above
   them picks the topic. When those two finish level - same score, and the same
   distance out on the tiebreaker - nothing is left to say which of them takes
   which job, and the old answer settled it alphabetically and settled it that
   way every time. So they call it, and the quiz maker flips a coin. */
test('a level bottom two call a coin for next week\u2019s jobs', async () => {
  // Ali runs it, so does not rank. Bea and Newcomer play, both members: a
  // guest never inherits the quiz, so a guest is never in the toss either.
  const before = await stateAs('ali');
  await call('/api/roles', { method: 'POST', body: { quizMasterId: before.me }, as: 'ali' });
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Level',
      questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0 }],
      tieBreaker: { text: 'n?', unit: '', answer: 10 } } }
  });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  // Both wrong, then both exactly as far out on the tiebreaker: dead level.
  for (const who of ['bea', 'newbie']) {
    await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: who });
  }
  await advanceTo('tb');
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 7 }, as: 'bea' });
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 13 }, as: 'newbie' });

  const waiting = await advanceTo('tba');
  assert.ok(waiting.live.coin, 'the quiz maker is told a coin is coming');
  assert.equal(waiting.live.coin.result, null, 'and nothing is decided yet');
  assert.deepEqual(waiting.live.coin.players.map((p) => p.name).sort(), ['Bea', 'Newcomer'],
    'between the two who finished level');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });
  assert.equal((await stateAs('ali')).live.phase, 'coin', 'a slide of its own, before the scores');

  // It is theirs to call and nobody else's - not even the quiz maker's.
  const meddle = await call('/api/live/call', { method: 'POST', body: { side: 'heads' }, as: 'ali' });
  assert.equal(meddle.status, 403, 'the quiz maker holds every other control, but not this one');

  assert.equal((await call('/api/live/call', { method: 'POST', body: { side: 'sideways' }, as: 'bea' })).status,
    400, 'heads or tails, nothing else');
  assert.equal((await call('/api/live/call', { method: 'POST', body: { side: 'heads' }, as: 'bea' })).status, 200);
  assert.equal((await call('/api/live/call', { method: 'POST', body: { side: 'heads' }, as: 'newbie' })).status,
    409, 'one side each, and Bea called that one');
  assert.equal((await call('/api/live/call', { method: 'POST', body: { side: 'tails' }, as: 'newbie' })).status, 200);

  // Un-flipped it cannot be walked past: it decides who writes the quiz.
  const early = await call('/api/live/advance', { method: 'POST', as: 'ali' });
  assert.equal(early.status, 409, 'the coin has to land first');

  const theirs = await call('/api/live/flip', { method: 'POST', as: 'bea' });
  assert.equal(theirs.status, 403, 'and only the quiz maker flips it');

  const flip = await call('/api/live/flip', { method: 'POST', as: 'ali' });
  assert.equal(flip.status, 200);
  assert.ok(['heads', 'tails'].includes(flip.body.result));

  const landed = (await stateAs('bea')).live.coin;
  assert.equal(landed.result, flip.body.result, 'the same result on every screen');
  const called = landed.players.find((p) => p.call === landed.result);
  assert.equal(landed.winnerId, called.userId, 'whoever called it right wins');
  assert.notEqual(landed.loserId, landed.winnerId);

  // Pressing it again is the first press, not a second roll.
  await call('/api/live/flip', { method: 'POST', as: 'ali' });
  assert.equal((await stateAs('ali')).live.coin.result, flip.body.result, 'it does not land twice');

  const board = await advanceTo('board');
  const places = board.live.ranking.map((r) => r.userId);
  assert.equal(places[places.length - 1], landed.loserId, 'the loser takes the wooden spoon');

  await call('/api/live/finish', { method: 'POST', as: 'ali' });
  const after = await stateAs('ali');
  assert.equal(after.upcoming.quizMasterId, landed.loserId, 'and writes next week\u2019s quiz');
  assert.equal(after.upcoming.topicPickerId, landed.winnerId, 'while the winner picks the topic');
  assert.match(after.upcoming.reason.master, /toss/, 'and the rota says why');
});

/* One of them wandering off must not strand the quiz maker on a slide that
   cannot be walked past. The call that was made stands, and the side nobody
   took goes to the one who never called. */
test('a coin still lands when only one of them called it', async () => {
  const state = await stateAs('ali');
  await call('/api/roles', { method: 'POST', body: { quizMasterId: state.me }, as: 'ali' });
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Absent',
      questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0 }],
      tieBreaker: { text: 'n?', unit: '', answer: 10 } } }
  });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');
  for (const who of ['bea', 'newbie']) {
    await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: who });
  }
  await advanceTo('tb');
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 7 }, as: 'bea' });
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 13 }, as: 'newbie' });
  await advanceTo('coin');

  // Only Bea calls. Newcomer has put their phone in their pocket.
  await call('/api/live/call', { method: 'POST', body: { side: 'tails' }, as: 'bea' });
  const flip = await call('/api/live/flip', { method: 'POST', as: 'ali' });
  assert.equal(flip.status, 200, 'it lands anyway');

  const landed = (await stateAs('ali')).live.coin;
  assert.equal(landed.players.find((p) => p.name === 'Bea').call, 'tails', 'the call made stands');
  assert.equal(landed.players.find((p) => p.name === 'Newcomer').call, 'heads',
    'and the side nobody took goes to the one who never called');
  assert.ok(landed.winnerId && landed.loserId, 'so it still separates them');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* The coin exists to hand out those two jobs. Level anywhere else in the table
   decides nothing, so there is nothing to toss for. */
test('a tie further up the table is not tossed for', async () => {
  const state = await stateAs('ali');
  await call('/api/roles', { method: 'POST', body: { quizMasterId: state.me }, as: 'ali' });
  await call('/api/quiz', {
    method: 'PUT', as: 'ali',
    body: { quiz: { topic: 'Top-heavy',
      questions: [{ id: 'q1', text: '?', options: ['a', 'b'], correct: 0 }],
      tieBreaker: { text: 'n?', unit: '', answer: 10 } } }
  });
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  await advanceTo('q');

  // Bea and Newcomer level in first; Spare alone at the bottom.
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'newbie' });
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'spare' });
  await advanceTo('tb');
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 7 }, as: 'bea' });
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 13 }, as: 'newbie' });
  await call('/api/live/tiebreak', { method: 'POST', body: { value: 10 }, as: 'spare' });

  const seen = await advanceTo('tba');
  assert.equal(seen.live.coin, null, 'level in first and second settles nothing');

  await call('/api/live/advance', { method: 'POST', as: 'ali' });
  assert.equal((await stateAs('ali')).live.phase, 'board', 'so the coin slide never appears');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});
