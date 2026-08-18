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
const nameOf = (state, id) => (state.users.find((u) => u.id === id) || {}).name;

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

  await call('/api/live/advance', { method: 'POST', as: 'ali' });   // lobby -> question

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
  const media = { id: 'a'.repeat(32), mime: 'image/jpeg', name: 'badger.jpg' };
  const saved = await call('/api/quiz', {
    method: 'PUT',
    as: 'ali',
    body: {
      quiz: {
        topic: 'Animals',
        questions: [{
          id: 'q1', text: 'Which one is the badger?',
          options: ['', ''],
          optionMedia: [media, { ...media, name: 'fox.jpg' }],
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
  await call('/api/live/advance', { method: 'POST', as: 'ali' });        // lobby -> q0

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
  await call('/api/live/advance', { method: 'POST', as: 'ali' });        // lobby -> q0
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
  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // q0
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
  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // q0
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });
  await call('/api/live/advance', { method: 'POST', as: 'ali' });          // q1
  await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'bea' });

  const mid = await stateAs('bea');
  assert.equal(mid.live.myScore.of, 0,
    'two right already, but saying so would give the game away');

  await call('/api/live/stop', { method: 'POST', as: 'ali' });
});

/* The tiebreaker settles a tie, so a second go after watching the counter
   climb would be a second bite at it. */
test('the tiebreaker takes one guess each', async () => {
  await call('/api/live/start', { method: 'POST', as: 'ali' });
  for (let i = 0; i < 4; i++) await call('/api/live/advance', { method: 'POST', as: 'ali' });

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
  await call('/api/live/advance', { method: 'POST', as: 'ali' });
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
  await call('/api/live/advance', { method: 'POST', as: 'ali' });   // lobby -> question

  const wrong = await call('/api/live/answer', { method: 'POST', body: { option: 0 }, as: 'cal' });
  assert.equal(wrong.status, 200, 'a guest can answer');
  await call('/api/live/answer', { method: 'POST', body: { option: 1 }, as: 'bea' });

  // The quiz master cannot route around it either.
  const state = await stateAs('ali');
  const guestId = state.users.find((u) => u.guest).id;
  const override = await call('/api/live/roles', { method: 'POST', body: { quizMasterId: guestId }, as: 'ali' });
  assert.equal(override.status, 400);

  for (let i = 0; i < 6; i++) await call('/api/live/advance', { method: 'POST', as: 'ali' });

  const before_ = await stateAs('ali');
  const ranked = before_.live.ranking.map((r) => nameOf(before_, r.userId));
  assert.ok(ranked.includes('Casual Cal'), 'the guest is on the board');

  await call('/api/live/finish', { method: 'POST', as: 'ali' });

  const after_ = await stateAs('ali');
  const master = after_.users.find((u) => u.id === after_.upcoming.quizMasterId);
  assert.equal(master.guest, false, 'next week went to a member, not the guest who came last');
  assert.equal(master.name, 'Bea');
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
