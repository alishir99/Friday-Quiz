/* server.mjs: Friday Quiz. Accounts, live game state, real-time push.
 * Zero dependencies.
 *
 *   node server.mjs            → http://localhost:8080
 *   node server.mjs 3000       → a different port
 *
 * Everyone opens the same link. The quiz master runs the slides on the big
 * screen; everybody else answers on their phone.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Secrets (DEEPSEEK_API_KEY) live in .env, not the shell, so `node server.mjs`
// keeps working as documented without anyone having to export anything first.
try { process.loadEnvFile(join(ROOT, '.env')); } catch {}

const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.QUIZ_DATA_DIR || join(ROOT, 'data');
const DATA_FILE = join(DATA_DIR, 'friday-quiz.json');
const MEDIA_DIR = join(DATA_DIR, 'media');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
/* Behind a TLS proxy, bind to loopback so the plain-HTTP port is not reachable
   from the internet. Unset (the default) keeps the LAN behaviour for phones. */
const BIND = process.env.QUIZ_BIND || '0.0.0.0';
// Set on a public deployment; leave empty on a trusted LAN to keep sign-up open.
const INVITE_CODE = String(process.env.QUIZ_INVITE_CODE || '').trim();
const MAX_BODY = 4 * 1024 * 1024;
const MAX_MEDIA = 48 * 1024 * 1024;
const QUESTION_COUNT = 10;     // how many a fresh quiz starts with
const MAX_QUESTIONS = 20;      // how many the quiz master can grow it to
const DEFAULT_OPTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/* What a question may carry. The server picks the file extension from this
   table rather than trusting anything the browser sends. */
const MEDIA_TYPES = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png':  { kind: 'image', ext: 'png' },
  'image/gif':  { kind: 'image', ext: 'gif' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/avif': { kind: 'image', ext: 'avif' },
  'audio/mpeg': { kind: 'audio', ext: 'mp3' },
  'audio/mp4':  { kind: 'audio', ext: 'm4a' },
  'audio/x-m4a': { kind: 'audio', ext: 'm4a' },
  'audio/aac':  { kind: 'audio', ext: 'aac' },
  'audio/ogg':  { kind: 'audio', ext: 'ogg' },
  'audio/wav':  { kind: 'audio', ext: 'wav' },
  'audio/x-wav': { kind: 'audio', ext: 'wav' },
  'audio/webm': { kind: 'audio', ext: 'weba' },
  'video/mp4':  { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'video/ogg':  { kind: 'video', ext: 'ogv' },
  'video/quicktime': { kind: 'video', ext: 'mov' }
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

/* Extension back to content type, for serving uploaded media. */
const MEDIA_MIME = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([mime, m]) => [m.ext, mime])
);

/* database */

const EMPTY = () => ({
  schema: 6,
  users: [],          // { id, name, active, joinedAt, salt, hash }, or for a
                      // guest { id, name, active, joinedAt, guest: true }
  history: [],        // finished sessions
  upcoming: null,     // { id, date, quizMasterId, topicPickerId, reason, topic, quiz }
  live: null,         // running game
  adminId: null,      // fixed person, not weekly-rotating; null until someone claims it
  revealMode: 'end',  // 'end' or 'each'; what the next game starts with
  rules: ''           // free text, editable by the admin only
});

let db = EMPTY();
let tokens = new Map();          // token -> userId   (memory only; sign in again after a restart)

async function loadDb() {
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    db = { ...EMPTY(), ...raw };
    db.live = null;              // never resume a half-finished game across a restart
  } catch {
    db = EMPTY();
  }
}

let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify({ ...db, live: null }, null, 2);
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, DATA_FILE);
  }).catch((e) => console.error('save failed:', e.message));
  return writeChain;
}

/* helpers */

const uid = () => randomBytes(8).toString('hex');
const userById = (id) => db.users.find((u) => u.id === id) || null;
const isAdmin = (id) => !!db.adminId && db.adminId === id;
// Guests play and score like everyone else, but never host and never admin.
const isGuest = (id) => { const u = userById(id); return !!(u && u.guest); };
/* Removed, not deleted. Their past quizzes still show their name - only
   `active: false` is ever written, so nothing that points at them breaks.
   Older records have no flag at all, which counts as present. */
const isRemoved = (id) => { const u = userById(id); return !!u && u.active === false; };
const activeUsers = () => db.users.filter((u) => u.active !== false);
// Names and the invite code are matched loosely; passwords never are.
const sameCode = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const MAX_NAME = 40;
const MAX_RULES = 20000;
const MIN_PASSWORD = 4;

/* Quiz-writing assistant. Raw HTTPS rather than an SDK - this app has no
   npm install step at all, and that stays true for this too. DeepSeek has
   no hosted web-search tool the way some providers do, so unlike a
   search-backed assistant this one cannot cite live sources - it answers
   from what the model already knows, and is told to say so when unsure
   rather than inventing a confident-sounding fact. */
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_ASSIST_MESSAGE = 2000;
const MAX_ASSIST_HISTORY = 20;
const ASSIST_SYSTEM = `You are Quizzy, the quiz master's humble servant: a cheerful, slightly theatrical butler who helps write questions for a weekly pub-style trivia quiz. Keep that voice light - a wry aside is welcome, a paragraph of it is not.

For a quick question or an idea, just reply in plain, friendly text.

When asked to write a whole quiz, "all the questions", or a batch of questions, reply with one short friendly sentence, then a fenced \`\`\`json code block containing exactly this shape and nothing else inside the fence:
{
  "questions": [
    { "text": "...", "options": ["...", "...", "...", "..."], "correct": 0, "note": "...",
      "mediaHint": "", "optionHints": ["", "", "", ""] }
  ],
  "tieBreaker": { "text": "...", "answer": 123, "unit": "", "note": "..." }
}
Write exactly 10 questions unless told otherwise. Each question needs 2 to 6 short options, one correct 0-based "correct" index, and a short optional "note" with a fun fact or explanation. The tiebreaker's "answer" must be a plain number.

About pictures and sound: you cannot make, find or attach a file - only the quiz master can, from their own machine. What you can do is say what each slot needs, and they will go and get it. "mediaHint" describes a file for the question itself; "optionHints" describes one per option, in the same order, empty string where nothing is needed. Keep each hint to a few words naming the file plainly - "a lion roaring, a few seconds" or "photograph of a badger". Only fill them in when the request actually calls for media, and leave them out entirely otherwise.

So for "guess the animal from the sound, with pictures to choose from", each question gets a "mediaHint" of the animal's call and four "optionHints" naming a photograph of each candidate animal, while "options" holds the animal names as the labels. Say plainly in your one-sentence reply that the files are theirs to add.

Match whatever tone is asked for - funny, serious, whatever. You have no way to check the web right now, so get facts as right as you can from what you already know, and if you are genuinely unsure of one, say so plainly in your one-sentence reply rather than presenting a guess as certain.`;

function extractQuiz(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!m) return { reply: text || '(no reply)', quiz: null };
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && Array.isArray(parsed.questions) && parsed.questions.length) {
      const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
      return { reply: cleaned || 'Here you go - take a look below.', quiz: parsed };
    }
  } catch {}
  return { reply: text || '(no reply)', quiz: null };
}

async function askAssistant(history, topic) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('The assistant needs DEEPSEEK_API_KEY set - put it in .env and restart the server');

  const system = ASSIST_SYSTEM + (topic ? `\n\nThis week's topic, if it helps: "${topic}"` : '');

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'system', content: system }, ...history]
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error((body && body.error && body.error.message) || `Assistant error (${res.status})`);
  const text = (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
  return extractQuiz(text.trim());
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return check.length === stored.length && timingSafeEqual(check, stored);
}

function nextFriday(from) {
  const d = from ? new Date(from) : new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/* The day this quiz is actually for. The scheduled date is written once and
   then sits there, so a week nobody got round to playing would otherwise show
   a Friday that has already been and gone. An unplayed quiz is due now.
   ISO dates compare correctly as strings, which is why they are kept that way. */
function effectiveDate(iso) {
  const today = todayISO();
  return (!iso || iso < today) ? today : iso;
}

function blankQuiz(authorId, topic) {
  return {
    authorId, topic: topic || '', createdAt: new Date().toISOString(),
    questions: Array.from({ length: QUESTION_COUNT }, () => ({
      id: uid(), text: '', options: Array.from({ length: DEFAULT_OPTIONS }, () => ''),
      /* Media per option, alongside rather than inside options[], so every
         quiz already in the history keeps working untouched - they simply
         have no optionMedia and nothing tries to draw one. */
      optionMedia: Array.from({ length: DEFAULT_OPTIONS }, () => null),
      correct: null, note: '', media: null
    })),
    tieBreaker: { text: '', answer: null, unit: '', note: '', media: null }
  };
}

/* Keep only a media reference we wrote ourselves. The file name is rebuilt
   from the id and kind, so nothing the client sends can escape MEDIA_DIR. */
function cleanMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const type = MEDIA_TYPES[m.mime];
  if (!type) return null;
  if (typeof m.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(m.id)) return null;
  return { id: m.id, kind: type.kind, mime: m.mime, name: String(m.name || '').slice(0, 120) };
}

/* An option counts once it has something to show - words, a picture, or both.
   "Which of these is a badger?" under four photographs is a real question with
   four blank labels. */
function optionFilled(q, i) {
  return !!String(q.options[i] || '').trim() || !!(q.optionMedia && q.optionMedia[i]);
}

function questionReady(q) {
  const filled = q.options.filter((_, i) => optionFilled(q, i));
  return !!q.text.trim() && filled.length >= MIN_OPTIONS
    && Number.isInteger(q.correct) && optionFilled(q, q.correct);
}
function tieReady(tb) {
  return !!(tb && tb.text.trim() && tb.answer !== null && Number.isFinite(Number(tb.answer)));
}
function quizReady(quiz) {
  return !!quiz && quiz.questions.every(questionReady) && tieReady(quiz.tieBreaker);
}

/* live game phases. Two ways round the course, the quiz master's choice:

   'end'  (the pub way, and the default)
     lobby → q0..q9 → tb → gap → a0..a9 → tba → board → roles
     Nobody learns anything until the end, so a wrong answer early does not
     take the wind out of the room.

   'each' (the Kahoot way)
     lobby → q0 → a0 → q1 → a1 → … → q9 → a9 → tb → tba → board → roles
     Answer straight after each question, while people still remember it. */

const PHASES = ['lobby', 'q', 'tb', 'gap', 'a', 'tba', 'board', 'roles'];
const REVEAL_MODES = ['end', 'each'];
const revealMode = (live) => (live && live.reveal === 'each') ? 'each' : 'end';

/* qCount is however many questions are in the quiz actually being played,
   not a fixed number: the quiz master can add more than the starting ten. */
function advance(live, qCount) {
  const { phase, index } = live;
  const each = revealMode(live) === 'each';

  if (phase === 'lobby') { live.phase = 'q'; live.index = 0; return; }
  if (phase === 'q') {
    if (each) { live.phase = 'a'; return; }              // answer it now
    if (index < qCount - 1) live.index++;
    else { live.phase = 'tb'; live.index = 0; }
    return;
  }
  if (phase === 'tb') { live.phase = each ? 'tba' : 'gap'; return; }
  if (phase === 'gap') { live.phase = 'a'; live.index = 0; return; }
  if (phase === 'a') {
    if (each) {
      // Back to the next question, or on to the tiebreaker if that was the last.
      if (index < qCount - 1) { live.phase = 'q'; live.index++; }
      else { live.phase = 'tb'; live.index = 0; }
      return;
    }
    if (index < qCount - 1) live.index++;
    else { live.phase = 'tba'; }
    return;
  }
  if (phase === 'tba') { live.phase = 'board'; return; }
  if (phase === 'board') { live.phase = 'roles'; return; }
}

function back(live, qCount) {
  const { phase, index } = live;
  const each = revealMode(live) === 'each';

  if (phase === 'q') {
    if (each) {
      // The step before question n is the answer to n-1.
      if (index > 0) { live.phase = 'a'; live.index--; } else live.phase = 'lobby';
      return;
    }
    if (index > 0) live.index--; else live.phase = 'lobby';
    return;
  }
  if (phase === 'tb') {
    if (each) { live.phase = 'a'; live.index = qCount - 1; return; }
    live.phase = 'q'; live.index = qCount - 1; return;
  }
  if (phase === 'gap') { live.phase = 'tb'; return; }
  if (phase === 'a') {
    if (each) { live.phase = 'q'; return; }              // same question, unanswered
    if (index > 0) live.index--; else live.phase = 'gap';
    return;
  }
  if (phase === 'tba') {
    if (each) { live.phase = 'tb'; return; }
    live.phase = 'a'; live.index = qCount - 1; return;
  }
  if (phase === 'board') { live.phase = 'tba'; return; }
  if (phase === 'roles') { live.phase = 'board'; return; }
}

/* How many questions are in the quiz actually being (or just having been)
   played. db.upcoming.quiz is null once the week has rolled over, so once
   the result is committed the frozen count on live.final is the only
   accurate source left. */
function liveQuestionCount(live) {
  if (live && live.final) return live.final.questionCount;
  return (db.upcoming && db.upcoming.quiz && db.upcoming.quiz.questions.length) || QUESTION_COUNT;
}

const answersRevealed = (live) => !!live && ['gap', 'a', 'tba', 'board', 'roles'].includes(live.phase);

/* How many answers are public, counting from the first question. In 'end' mode
   it is all or nothing. In 'each' mode it walks forward one at a time, and the
   ones still to come have to stay off the wire - otherwise revealing question
   one would hand devtools the whole rest of the quiz. */
function revealedCount(live, qCount) {
  if (!live) return 0;
  if (revealMode(live) === 'each') {
    if (['tb', 'gap', 'tba', 'board', 'roles'].includes(live.phase)) return qCount;
    if (live.phase === 'a') return live.index + 1;
    return live.index;                       // on 'q': everything before it
  }
  return answersRevealed(live) ? qCount : 0;
}

/* scoring */

function scoreFor(userId, quiz, live) {
  const mine = live.answers[userId] || {};
  let score = 0;
  quiz.questions.forEach((q, i) => { if (mine[i] === q.correct) score++; });
  return score;
}

function rankLive() {
  const { live } = db;
  // Once the week is committed the ranking is frozen. db.upcoming has already
  // rolled over to a blank next Friday and can no longer be re-scored.
  if (live && live.final) return live.final.ranking;
  const quiz = db.upcoming && db.upcoming.quiz;
  if (!quiz) return [];
  const tieAnswer = Number(quiz.tieBreaker.answer);
  const hosted = {};
  db.history.forEach((s) => { hosted[s.quizMasterId] = (hosted[s.quizMasterId] || 0) + 1; });

  const masterId = db.upcoming.quizMasterId;
  const rows = live.players
    .filter((id) => id !== masterId)
    .map((id) => {
      const u = userById(id);
      const guess = live.tieGuesses[id];
      const diff = (guess === undefined || guess === null) ? Infinity : Math.abs(Number(guess) - tieAnswer);
      return {
        userId: id,
        name: u ? u.name : 'Unknown',
        score: scoreFor(id, quiz, live),
        tieGuess: guess === undefined ? null : Number(guess),
        diff,
        hosted: hosted[id] || 0
      };
    });

  rows.sort((a, b) =>
    b.score - a.score ||
    a.diff - b.diff ||
    a.hosted - b.hosted ||
    a.name.localeCompare(b.name));

  rows.forEach((r, i) => {
    r.place = i + 1;
    const same = (o) => o && o.score === r.score && o.diff === r.diff;
    r.unresolved = !!(same(rows[i - 1]) || same(rows[i + 1]));
  });
  return rows;
}

/* Everyone's tiebreaker guess, closest first, so the room can see who was
   nearest. Only ever built once the answer is on the screen. */
function tieRows() {
  const live = db.live;
  if (!live) return null;

  if (live.final) {
    return live.final.ranking.map((r) => ({
      userId: r.userId, name: r.name,
      guess: r.tieGuess === undefined ? null : r.tieGuess,
      diff: Number.isFinite(r.diff) ? r.diff : null
    })).sort(byNearest);
  }

  const quiz = db.upcoming && db.upcoming.quiz;
  if (!quiz) return null;
  const answer = Number(quiz.tieBreaker.answer);
  const masterId = db.upcoming.quizMasterId;

  return live.players
    .filter((id) => id !== masterId)
    .map((id) => {
      const u = userById(id);
      const raw = live.tieGuesses[id];
      const guess = (raw === undefined || raw === null) ? null : Number(raw);
      return {
        userId: id,
        name: u ? u.name : 'Unknown',
        guess,
        diff: guess === null ? null : Math.abs(guess - answer)
      };
    })
    .sort(byNearest);
}

function byNearest(a, b) {
  // Anyone who never guessed goes to the bottom.
  if ((a.diff === null) !== (b.diff === null)) return a.diff === null ? 1 : -1;
  if (a.diff !== b.diff) return a.diff - b.diff;
  return a.name.localeCompare(b.name);
}

function deriveRoles(rows) {
  // A guest can finish last without inheriting next week's quiz - they are
  // here for one night and may never come back.
  const eligible = rows.filter((r) => !isGuest(r.userId) && !isRemoved(r.userId));
  if (!eligible.length) {
    // Only guests played. Leave next week exactly as it stands rather than
    // handing the quiz to someone who cannot write it.
    return {
      quizMasterId: db.upcoming ? db.upcoming.quizMasterId : null,
      topicPickerId: db.upcoming ? db.upcoming.topicPickerId : null,
      reason: { master: 'No one new to hand it to', picker: 'No one new to hand it to' }
    };
  }
  const last = eligible[eligible.length - 1];
  const second = eligible.length > 1 ? eligible[eligible.length - 2] : eligible[0];
  const qCount = liveQuestionCount(db.live);
  return {
    quizMasterId: last.userId,
    topicPickerId: second.userId,
    reason: {
      master: `Finished last (${last.score}/${qCount})`,
      picker: `Finished second from last (${second.score}/${qCount})`
    }
  };
}

/* How many of the answers shown so far this player got right. Bounded by
   `revealed`, so it can never run ahead of what is on the screen. */
function myScoreSoFar(live, userId, revealed) {
  const quiz = db.upcoming && db.upcoming.quiz;
  const upTo = Math.min(revealed || 0, quiz ? quiz.questions.length : 0);
  if (!live || !quiz || upTo <= 0) return { right: 0, of: 0 };
  const mine = live.answers[userId] || {};
  let right = 0;
  for (let i = 0; i < upTo; i++) if (mine[i] === quiz.questions[i].correct) right++;
  return { right, of: upTo };
}

/* redaction */
/* Correct answers never reach a player's browser before the reveal,
   otherwise anyone with devtools can read them straight off the wire. The
   topic is held back the same way: only the picker and the quiz master need
   it beforehand, so for everyone else it stays off the wire entirely. */

function visibleQuiz(quiz, canSeeAnswers, canSeeTopic, revealed, tieRevealed) {
  if (!quiz) return null;
  const topic = canSeeTopic ? quiz.topic : '';
  if (canSeeAnswers) return { ...quiz, topic };
  const upTo = revealed || 0;
  return {
    topic,
    authorId: quiz.authorId,
    // Answered questions carry their answer; the rest are stripped of it.
    questions: quiz.questions.map((q, i) => (i < upTo ? { ...q } : {
      id: q.id, text: q.text, options: q.options,
      optionMedia: q.optionMedia || null, media: q.media || null
    })),
    tieBreaker: tieRevealed ? { ...quiz.tieBreaker } : {
      text: quiz.tieBreaker.text,
      unit: quiz.tieBreaker.unit,
      media: quiz.tieBreaker.media || null
    }
  };
}

function stateFor(userId) {
  const isMaster = !!db.upcoming && db.upcoming.quizMasterId === userId;
  const isPicker = !!db.upcoming && db.upcoming.topicPickerId === userId;
  const live = db.live;
  // In 'each' mode answersRevealed() is true from the first answer onwards, so
  // it can no longer be the gate on its own - revealed counts the questions
  // that are actually done, and the rest stay redacted.
  const canSeeAnswers = isMaster || (revealMode(live) !== 'each' && answersRevealed(live));
  const revealed = isMaster ? liveQuestionCount(live) : revealedCount(live, liveQuestionCount(live));
  const tieRevealed = isMaster || (!!live && ['tba', 'board', 'roles'].includes(live.phase));
  // The topic is a surprise for the rest of the team: the picker chose it and
  // the quiz master has to write to it, nobody else needs to know. It stops
  // being a secret once the quiz actually starts and it goes up on the big
  // screen - but not in the lobby, which is precisely when the quiz master is
  // sharing their screen and waiting for people to scan in.
  const canSeeTopic = isMaster || isPicker || (!!live && live.phase !== 'lobby');

  const online = onlineIds();
  const out = {
    users: db.users.map((u) => ({ id: u.id, name: u.name, active: u.active, guest: !!u.guest, online: online.has(u.id) })),
    /* Every past quiz's questions used to ride along here - and this whole
       object is rebuilt and pushed to every connected phone on every answer.
       After a year that was a megabyte per player per keystroke. The list and
       the all-time table only need the rankings; the questions are fetched
       from /api/history/<id>/quiz when someone actually opens one. */
    history: db.history.map(({ quiz, ...rest }) => ({
      ...rest,
      questionCount: quiz && quiz.questions ? quiz.questions.length : QUESTION_COUNT
    })),
    adminId: db.adminId,
    rules: db.rules,
    // What the next game will do, set from the dashboard before kick-off.
    revealMode: REVEAL_MODES.includes(db.revealMode) ? db.revealMode : 'end',
    upcoming: db.upcoming ? {
      ...db.upcoming,
      date: effectiveDate(db.upcoming.date),
      topic: canSeeTopic ? db.upcoming.topic : '',
      // Everyone still sees *that* a topic has been picked, just not what it is.
      topicSet: !!String(db.upcoming.topic || '').trim(),
      quiz: visibleQuiz(db.upcoming.quiz, canSeeAnswers, canSeeTopic, revealed, tieRevealed),
      quizReady: quizReady(db.upcoming.quiz)
    } : null,
    live: null,
    me: userId
  };

  if (live) {
    const mine = live.answers[userId] || {};
    const masterId = live.final ? live.final.quizMasterId : (db.upcoming && db.upcoming.quizMasterId);
    const others = live.players.filter((p) => p !== masterId);
    const ranking = ['board', 'roles'].includes(live.phase) ? rankLive() : null;

    out.live = {
      id: live.id,
      phase: live.phase,
      index: live.index,
      // Held back in the lobby the same way the answers are - a player with
      // devtools should not be able to read it off the wire either.
      topic: canSeeTopic ? (live.final ? live.final.topic : (db.upcoming ? db.upcoming.topic : '')) : '',
      quizMasterId: masterId,
      players: live.players,
      answeredCount: others.filter((p) => (live.answers[p] || {})[live.index] !== undefined).length,
      playerCount: others.length,
      tieCount: others.filter((p) => live.tieGuesses[p] !== undefined).length,
      myAnswers: mine,
      myTieGuess: live.tieGuesses[userId] ?? null,
      /* A running score, counted only over the answers already shown. Counting
         the unrevealed ones would tell a player how the earlier questions went
         before the reveal - which is the whole thing 'end' mode exists to stop.
         `of` is how many have been revealed, so the client can tell a score of
         nothing yet from a genuine nought. */
      myScore: myScoreSoFar(live, userId, revealed),
      // Held back until the tiebreaker answer is up, like the answers are.
      tieRows: ['tba', 'board', 'roles'].includes(live.phase) ? tieRows() : null,
      ranking,
      nextRoles: live.phase === 'roles'
        ? (live.final ? live.final.roles : (live.roleOverride || deriveRoles(rankLive())))
        : null,
      questionCount: liveQuestionCount(live),
      reveal: revealMode(live),
      committed: !!live.committed
    };
  }
  return out;
}

/* real-time push (SSE) */

const clients = new Set();       // { res, userId }, one per open tab

// Who has a live connection right now, not "whose account still exists".
// A person can have several tabs open; they only count once.
function onlineIds() {
  const ids = new Set();
  for (const c of clients) ids.add(c.userId);
  return ids;
}

function broadcast() {
  for (const c of clients) {
    try {
      c.res.write(`data: ${JSON.stringify(stateFor(c.userId))}\n\n`);
    } catch {
      clients.delete(c);
    }
  }
}

/* http plumbing */

function send(res, code, body, type, extraHeaders = {}) {
  res.writeHead(code, {
    'content-type': type || 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}
const json = (res, code, obj, headers) =>
  send(res, code, JSON.stringify(obj), MIME['.json'], headers);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('too big')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('That file is too big')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith('fq_token='));
  return hit ? decodeURIComponent(hit.slice('fq_token='.length)) : null;
}
const whoami = (req) => tokens.get(cookieToken(req)) || null;

/* Behind a TLS proxy the app itself still speaks plain HTTP, so the header is
   the only way to know the browser is on HTTPS. Spoofing it only adds Secure
   to the attacker's own cookie, so it does not need to be trusted carefully. */
const isHttps = (req) =>
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function setTokenCookie(userId, secure) {
  const token = randomBytes(24).toString('hex');
  tokens.set(token, userId);
  return `fq_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}`
    + (secure ? '; Secure' : '');
}

/* Make sure there is always something for the next Friday. */
function ensureUpcoming() {
  if (db.upcoming) return;
  // Seed from members only - a guest who happens to arrive first should not
  // end up owning the first Friday.
  const members = db.users.filter((u) => !u.guest && u.active !== false);
  if (members.length < 2) return;
  const [a, b] = members;
  db.upcoming = {
    id: uid(), date: nextFriday(), quizMasterId: a.id, topicPickerId: b.id,
    reason: { master: 'First quiz of the season', picker: 'First quiz of the season' },
    topic: '', quiz: null
  };
}

/* routes */

async function api(req, res, path) {
  const me = whoami(req);
  const requireUser = () => { if (!me) { json(res, 401, { error: 'Please sign in' }); return null; } return me; };
  const isMaster = () => !!db.upcoming && db.upcoming.quizMasterId === me;
  // Whoever started the running game keeps the controls, even after the
  // results are saved and the role has already passed to someone else.
  const runsLive = () => !!db.live &&
    me === (db.live.final ? db.live.final.quizMasterId : (db.upcoming && db.upcoming.quizMasterId));

  /* Accounts */

  /* Name plus password. First time creates the account with that password;
     every time after that it has to match. A teammate who forgot theirs gets
     it reset by the admin from the team page (see /api/reset-password) rather
     than through an email flow - nothing beyond a name is collected here. */
  if (path === '/api/login' && req.method === 'POST') {
    const { name, password, invite } = await readBody(req);
    const clean = String(name || '').trim().slice(0, MAX_NAME);
    const pass = String(password || '');
    if (!clean) return json(res, 400, { error: 'Enter your name' });
    if (pass.length < MIN_PASSWORD) return json(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    /* Guests are invisible here on purpose. A guest record has no hash, so
       matching one would drop into the "account predates passwords" branch
       below and adopt it - handing over an account without ever asking for
       the invite code, since that is only checked for brand-new names. */
    let user = db.users.find((u) => !u.guest && u.name.toLowerCase() === clean.toLowerCase());
    if (!user) {
      /* On a public URL an open sign-up is the whole perimeter: anyone who
         finds the address could make an account and, if nobody has claimed it
         yet, take admin. Signing in to an existing account never needs the
         code, so the team only sees this once. */
      /* Case and stray spaces are forgiven. It is a phrase passed round by
         word of mouth, so it arrives capitalised however the person who typed
         it felt at the time - and it is a gate against strangers, not a
         password. Passwords stay exactly as typed. */
      if (INVITE_CODE && !sameCode(invite, INVITE_CODE)) {
        return json(res, 403, {
          error: String(invite || '').trim()
            ? 'That invite code is not right.'
            : 'New here? You need the invite code from whoever runs the quiz.',
          needInvite: true
        });
      }
      const { salt, hash } = hashPassword(pass);
      user = { id: uid(), name: clean, active: true, joinedAt: new Date().toISOString(), salt, hash };
      db.users.push(user);
      ensureUpcoming();
      await persist();
      broadcast();
    } else if (!user.hash) {
      // Account predates passwords: whatever is typed the first time becomes it.
      Object.assign(user, hashPassword(pass));
      await persist();
    } else if (user.active === false) {
      /* Checked after the password so a wrong guess still says "wrong
         password" - otherwise this doubles as a way to probe who was removed. */
      if (!verifyPassword(pass, user.salt, user.hash)) {
        return json(res, 401, { error: 'Wrong password for "' + user.name + '". If that is not you, sign in with a different name (e.g. add a last initial).' });
      }
      return json(res, 403, { error: 'That account has been removed. Ask the admin if this is a mistake.' });
    } else if (!verifyPassword(pass, user.salt, user.hash)) {
      // Could be a typo, or someone else who happens to share this name and
      // has never seen this account's password - the message covers both.
      return json(res, 401, { error: 'Wrong password for "' + user.name + '". If that is not you, sign in with a different name (e.g. add a last initial).' });
    }
    return json(res, 200, { ok: true, me: user.id },
      { 'set-cookie': setTokenCookie(user.id, isHttps(req)) });
  }

  /* A nickname and nothing else, for someone who is here for one night. No
     password and no invite code: the barrier for a guest is knowing the quiz
     is happening. They play and score like anyone else but never host and
     never take admin - see isGuest() at the top. */
  if (path === '/api/join' && req.method === 'POST') {
    const { name } = await readBody(req);
    const clean = String(name || '').trim().slice(0, MAX_NAME);
    if (!clean) return json(res, 400, { error: 'Enter a name' });
    // Guests may share a name with each other, but not with the team - a
    // stranger should not be able to appear on the board as a teammate.
    if (db.users.some((u) => !u.guest && u.active !== false && u.name.toLowerCase() === clean.toLowerCase())) {
      return json(res, 409, { error: 'Someone on the team goes by that name. Try another.' });
    }
    /* Always a fresh account, even for a repeated name. With no password
       there is no way to prove you are the same guest as last time, so the
       safe reading of "Sam joins again" is that it is a different Sam. */
    const user = { id: uid(), name: clean, active: true, guest: true, joinedAt: new Date().toISOString() };
    db.users.push(user);
    ensureUpcoming();
    await persist();
    broadcast();
    return json(res, 200, { ok: true, me: user.id },
      { 'set-cookie': setTokenCookie(user.id, isHttps(req)) });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    tokens.delete(cookieToken(req));
    return json(res, 200, { ok: true }, { 'set-cookie': 'fq_token=; HttpOnly; Path=/; Max-Age=0' });
  }

  /* Self-service: change your own password while signed in. */
  if (path === '/api/change-password' && req.method === 'POST') {
    if (!requireUser()) return;
    const { oldPassword, newPassword } = await readBody(req);
    const user = userById(me);
    if (!verifyPassword(String(oldPassword || ''), user.salt, user.hash)) {
      return json(res, 401, { error: 'Current password is wrong' });
    }
    const next = String(newPassword || '');
    if (next.length < MIN_PASSWORD) return json(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    Object.assign(user, hashPassword(next));
    await persist();
    return json(res, 200, { ok: true });
  }

  /* Forgot password: the admin resets it and hands over the temporary
     password directly (in person, on Slack). There is no email on file, so
     this is the recovery path - it does mean that if the admin is ever
     unreachable, nobody else can help a locked-out teammate back in. */
  if (path === '/api/reset-password' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isAdmin(me)) return json(res, 403, { error: 'Only the admin can reset a password' });
    const { userId } = await readBody(req);
    const user = userById(userId);
    if (!user) return json(res, 404, { error: 'No such person' });
    const tempPassword = randomBytes(4).toString('hex');
    Object.assign(user, hashPassword(tempPassword));
    await persist();
    return json(res, 200, { ok: true, tempPassword });
  }

  /* Admin: a fixed person, not part of the weekly quiz-master/topic-picker
     rotation. Nobody starts as admin - whoever gets there first claims it,
     then only that person can hand it to someone else. */
  if (path === '/api/admin/claim' && req.method === 'POST') {
    if (!requireUser()) return;
    if (isGuest(me)) return json(res, 403, { error: 'Guests cannot be admin' });
    if (db.adminId) return json(res, 409, { error: 'There is already an admin' });
    db.adminId = me;
    await persist(); broadcast();
    return json(res, 200, { ok: true });
  }

  /* Removing someone. A flag rather than a delete: every past quiz they played
     still lists them, and the scoreboards keep working. They cannot sign in,
     do not appear on the team, and are out of the rota - but nothing that
     points at them dangles, and putting them back is one click. */
  if (path === '/api/admin/set-active' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isAdmin(me)) return json(res, 403, { error: 'Only the admin can do this' });
    const { userId, active } = await readBody(req);
    const target = userById(userId);
    if (!target) return json(res, 400, { error: 'No such person' });

    if (active === false) {
      // Each of these would leave a job with nobody holding it.
      if (userId === me) return json(res, 400, { error: 'You cannot remove yourself' });
      if (isAdmin(userId)) return json(res, 400, { error: 'Pass admin on first' });
      if (db.upcoming && db.upcoming.quizMasterId === userId) {
        return json(res, 409, { error: target.name + ' is writing the next quiz. Hand that over first.' });
      }
      if (db.upcoming && db.upcoming.topicPickerId === userId) {
        return json(res, 409, { error: target.name + ' is picking the next topic. Hand that over first.' });
      }
      target.active = false;
      // Out of the room, and out of any game already running.
      for (const [token, uid_] of tokens) if (uid_ === userId) tokens.delete(token);
      if (db.live) db.live.players = db.live.players.filter((p) => p !== userId);
    } else {
      target.active = true;
    }
    await persist(); broadcast();
    return json(res, 200, { ok: true, active: target.active });
  }

  if (path === '/api/admin/transfer' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isAdmin(me)) return json(res, 403, { error: 'Only the admin can do this' });
    const { userId } = await readBody(req);
    if (!userById(userId)) return json(res, 400, { error: 'No such person' });
    if (isGuest(userId)) return json(res, 400, { error: 'Guests cannot be admin' });
    if (isRemoved(userId)) return json(res, 400, { error: 'That person has been removed' });
    db.adminId = userId;
    await persist(); broadcast();
    return json(res, 200, { ok: true });
  }

  /* A page of house rules, visible to everyone, editable only by the admin. */
  if (path === '/api/rules' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isAdmin(me)) return json(res, 403, { error: 'Only the admin can edit this' });
    const { text } = await readBody(req);
    db.rules = String(text || '').slice(0, MAX_RULES);
    await persist(); broadcast();
    return json(res, 200, { ok: true });
  }

  /* One past quiz's questions and answers, fetched only when someone opens
     it. Safe to hand over: the game is long finished. */
  const pastQuiz = path.match(/^\/api\/history\/([a-f0-9]+)\/quiz$/);
  if (pastQuiz && req.method === 'GET') {
    if (!requireUser()) return;
    const session = db.history.find((h) => h.id === pastQuiz[1]);
    if (!session || !session.quiz) return json(res, 404, { error: 'No such quiz' });
    return json(res, 200, { ok: true, quiz: session.quiz });
  }

  if (path === '/api/state' && req.method === 'GET') {
    if (!me) return json(res, 200, { anonymous: true, anyUsers: db.users.length > 0 });
    return json(res, 200, stateFor(me));
  }

  /* Live updates */

  if (path === '/api/events') {
    if (!me) return json(res, 401, { error: 'Please sign in' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(stateFor(me))}\n\n`);
    const client = { res, userId: me };
    clients.add(client);
    // Opening the app during a game is what joining means - this is what the
    // lobby counts. Once in, you stay in: a phone locking should not drop you.
    if (db.live && !db.live.players.includes(me) && !isRemoved(me)) db.live.players.push(me);
    broadcast();      // tell everyone else this person just came online
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(beat); clients.delete(client); broadcast(); });
    return;
  }

  /* Setting up the week */

  if (path === '/api/topic' && req.method === 'POST') {
    if (!requireUser()) return;
    const { topic } = await readBody(req);
    if (!db.upcoming) return json(res, 400, { error: 'Nothing scheduled' });
    if (me !== db.upcoming.topicPickerId && !isMaster()) {
      return json(res, 403, { error: 'Only the topic picker can set this' });
    }
    db.upcoming.topic = String(topic || '').trim();
    if (db.upcoming.quiz) db.upcoming.quiz.topic = db.upcoming.topic;
    await persist(); broadcast();
    return json(res, 200, { ok: true });
  }

  if (path === '/api/quiz' && req.method === 'PUT') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz master can write the quiz' });
    const { quiz } = await readBody(req);
    if (!quiz || !Array.isArray(quiz.questions)) return json(res, 400, { error: 'Bad quiz' });
    quiz.questions = quiz.questions.slice(0, MAX_QUESTIONS).map((q) => {
      const options = (Array.isArray(q.options) ? q.options : [])
        .slice(0, MAX_OPTIONS).map((o) => String(o == null ? '' : o));
      while (options.length < MIN_OPTIONS) options.push('');
      const correct = Number.isInteger(q.correct) && q.correct >= 0 && q.correct < options.length
        ? q.correct : null;
      // One media slot per option, however mangled the array arrived.
      const src = Array.isArray(q.optionMedia) ? q.optionMedia : [];
      const optionMedia = options.map((_, i) => cleanMedia(src[i]));
      return { ...q, options, optionMedia, correct, media: cleanMedia(q.media) };
    });
    if (quiz.tieBreaker) quiz.tieBreaker.media = cleanMedia(quiz.tieBreaker.media);
    db.upcoming.quiz = { ...quiz, authorId: me, topic: db.upcoming.topic };
    await persist(); broadcast();
    return json(res, 200, { ok: true, ready: quizReady(db.upcoming.quiz) });
  }

  /* Media upload. The body is the raw file, the type comes from the header,
     which avoids hand-rolling a multipart parser for no benefit. */
  if (path === '/api/media' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz master can add media' });

    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const type = MEDIA_TYPES[mime];
    if (!type) return json(res, 415, { error: 'That kind of file is not supported' });

    const buf = await readRaw(req, MAX_MEDIA);
    if (!buf.length) return json(res, 400, { error: 'The file was empty' });

    const id = randomBytes(16).toString('hex');
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(join(MEDIA_DIR, id + '.' + type.ext), buf);

    return json(res, 200, {
      ok: true,
      media: {
        id, kind: type.kind, mime,
        name: String(req.headers['x-file-name'] || '').slice(0, 120)
      }
    });
  }

  /* Quiz-writing help: question ideas, or a whole quiz as JSON the client
     can insert directly. Same person who can already see the answers
     before the game. */
  if (path === '/api/assist' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only this week’s quiz master can use the assistant' });
    const { messages, topic } = await readBody(req);
    if (!Array.isArray(messages) || !messages.length) return json(res, 400, { error: 'No message' });
    const history = messages.slice(-MAX_ASSIST_HISTORY).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.text || '').slice(0, MAX_ASSIST_MESSAGE)
    }));
    try {
      const out = await askAssistant(history, String(topic || '').slice(0, 200));
      return json(res, 200, { ok: true, reply: out.reply, quiz: out.quiz });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (path === '/api/roles' && req.method === 'POST') {
    if (!requireUser()) return;
    // Deciding who does what next week is an admin call, not the weekly quiz
    // master's - those stay separate on purpose.
    if (!isAdmin(me)) return json(res, 403, { error: 'Only the admin can change this' });
    const { quizMasterId, topicPickerId } = await readBody(req);
    if (!db.upcoming) return json(res, 400, { error: 'Nothing scheduled' });
    if (quizMasterId && !userById(quizMasterId)) return json(res, 400, { error: 'No such person' });
    if (topicPickerId && !userById(topicPickerId)) return json(res, 400, { error: 'No such person' });
    if (quizMasterId && isGuest(quizMasterId)) return json(res, 400, { error: 'A guest cannot be quiz master' });
    if (topicPickerId && isGuest(topicPickerId)) return json(res, 400, { error: 'A guest cannot pick the topic' });
    if (quizMasterId && isRemoved(quizMasterId)) return json(res, 400, { error: 'That person has been removed' });
    if (topicPickerId && isRemoved(topicPickerId)) return json(res, 400, { error: 'That person has been removed' });
    if (quizMasterId) db.upcoming.quizMasterId = quizMasterId;
    if (topicPickerId) db.upcoming.topicPickerId = topicPickerId;
    db.upcoming.reason = { master: 'Set by hand', picker: 'Set by hand' };
    await persist(); broadcast();
    return json(res, 200, { ok: true });
  }

  /* Running the game */

  if (path === '/api/live/start' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz master can start it' });
    if (!quizReady(db.upcoming.quiz)) return json(res, 400, { error: 'The quiz is not finished yet' });
    db.live = {
      id: uid(), phase: 'lobby', index: 0,
      /* Whoever has the app open right now is in the room. Anyone else is
         added the moment they connect, further down in /api/events.

         Not the whole user list: that would have the lobby claiming a crowd
         before anyone had turned up, growing by one for every guest who ever
         played. And not an empty array either - the people already sitting
         there waiting for you to press Start are exactly the ones playing. */
      players: [...onlineIds()].filter((id) => !isRemoved(id)),
      reveal: REVEAL_MODES.includes(db.revealMode) ? db.revealMode : 'end',
      answers: {}, tieGuesses: {}, startedAt: new Date().toISOString()
    };
    broadcast();
    return json(res, 200, { ok: true });
  }

  /* When answers get shown: after every question, or all at the end. Settable
     before the game (remembered for next time) and during it, because which
     one suits only becomes obvious once the room is in front of you. */
  if (path === '/api/live/reveal' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz master decides this' });
    const { mode } = await readBody(req);
    if (!REVEAL_MODES.includes(mode)) return json(res, 400, { error: 'Unknown mode' });
    db.revealMode = mode;
    if (db.live) {
      db.live.reveal = mode;
      /* Switching mid-quiz can leave you on a step the new running order does
         not have - the gap only exists in 'end'. Nudge onto the nearest one
         that does rather than stranding the slides. */
      if (mode === 'each' && db.live.phase === 'gap') { db.live.phase = 'a'; db.live.index = 0; }
    }
    await persist(); broadcast();
    return json(res, 200, { ok: true, mode });
  }

  if ((path === '/api/live/advance' || path === '/api/live/back') && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz master controls the slides' });
    if (!db.live) return json(res, 400, { error: 'Nothing running' });
    (path.endsWith('advance') ? advance : back)(db.live, liveQuestionCount(db.live));
    broadcast();
    return json(res, 200, { ok: true, phase: db.live.phase, index: db.live.index });
  }

  if (path === '/api/live/answer' && req.method === 'POST') {
    if (!requireUser()) return;
    const { option } = await readBody(req);
    const live = db.live;
    if (!live || live.phase !== 'q') return json(res, 409, { error: 'Not taking answers now' });
    if (me === db.upcoming.quizMasterId) return json(res, 403, { error: 'You wrote this one' });
    if (!live.players.includes(me)) live.players.push(me);
    live.answers[me] = live.answers[me] || {};
    live.answers[me][live.index] = Number(option);
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/tiebreak' && req.method === 'POST') {
    if (!requireUser()) return;
    const { value } = await readBody(req);
    const live = db.live;
    if (!live || live.phase !== 'tb') return json(res, 409, { error: 'Not taking guesses now' });
    if (me === db.upcoming.quizMasterId) return json(res, 403, { error: 'You wrote this one' });
    /* One guess each. Unlike the questions, where changing your mind before the
       next slide is harmless, the tiebreaker decides a tie - letting someone
       resubmit after seeing the counter climb would be a second bite. The
       button locks on the phone too; this is what makes that mean anything. */
    if (live.tieGuesses[me] !== undefined) {
      return json(res, 409, { error: 'You have already guessed' });
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return json(res, 400, { error: 'That is not a number' });
    if (!live.players.includes(me)) live.players.push(me);
    live.tieGuesses[me] = n;
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/roles' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz master can change this' });
    const { quizMasterId, topicPickerId } = await readBody(req);
    if (!db.live) return json(res, 400, { error: 'Nothing running' });
    if (quizMasterId && isGuest(quizMasterId)) return json(res, 400, { error: 'A guest cannot be quiz master' });
    if (topicPickerId && isGuest(topicPickerId)) return json(res, 400, { error: 'A guest cannot pick the topic' });
    db.live.roleOverride = {
      quizMasterId, topicPickerId,
      reason: { master: 'Chosen by the quiz master', picker: 'Chosen by the quiz master' }
    };
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/finish' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz master can finish it' });
    const live = db.live;
    if (!live) return json(res, 400, { error: 'Nothing running' });
    if (live.committed) return json(res, 200, { ok: true });

    const rows = rankLive();
    const roles = live.roleOverride || deriveRoles(rows);
    const u = db.upcoming;

    db.history.push({
      id: live.id,
      // The day it was played, which is not the day it was booked for if it
      // slipped. playedAt below keeps the exact moment either way.
      date: effectiveDate(u.date),
      topic: u.topic,
      quizMasterId: u.quizMasterId,
      topicPickerId: u.topicPickerId,
      tieAnswer: Number(u.quiz.tieBreaker.answer),
      quiz: JSON.parse(JSON.stringify(u.quiz)),
      ranking: rows.map((r) => ({
        memberId: r.userId, name: r.name, score: r.score, tieGuess: r.tieGuess, place: r.place
      })),
      playedAt: new Date().toISOString()
    });

    // Freeze what the slides still need before upcoming rolls over.
    live.final = {
      ranking: rows,
      roles,
      topic: u.topic,
      quizMasterId: u.quizMasterId,
      questionCount: u.quiz.questions.length
    };
    live.committed = true;

    // Count forward from the day it was actually played. Measuring from a
    // date that has already passed would schedule the next one in the past
    // as well, and every week after that.
    const after = new Date(effectiveDate(u.date) + 'T12:00:00');
    after.setDate(after.getDate() + 1);
    db.upcoming = {
      id: uid(), date: nextFriday(after),
      quizMasterId: roles.quizMasterId, topicPickerId: roles.topicPickerId,
      reason: roles.reason, topic: '', quiz: null
    };
    await persist(); broadcast();
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/stop' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz master can stop it' });
    db.live = null;
    broadcast();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Unknown endpoint' });
}

/* server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    try {
      await api(req, res, path);
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: String(err.message || err) });
    }
    return;
  }

  /* Uploaded media. The name must match exactly what we wrote, so a crafted
     path cannot reach anything outside MEDIA_DIR. */
  if (path.startsWith('/media/')) {
    const name = path.slice('/media/'.length);
    const m = /^([a-f0-9]{16,64})\.([a-z0-9]{2,5})$/.exec(name);
    if (!m || !MEDIA_MIME[m[2]]) return send(res, 404, 'Not found');
    const file = join(MEDIA_DIR, m[1] + '.' + m[2]);
    if (!existsSync(file)) return send(res, 404, 'Not found');
    try {
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': MEDIA_MIME[m[2]],
        'content-length': buf.length,
        // Media never changes once written, so let the browser keep it.
        'cache-control': 'public, max-age=31536000, immutable'
      });
      return res.end(buf);
    } catch {
      return send(res, 500, 'Server error');
    }
  }

  /* Static files come only from public/, never from the project root. Serving
     the root would hand out .env, server.mjs and data/ to anyone who asked for
     them by name - the API key included. */
  const rel = path === '/' ? '/index.html' : path;
  const file = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return send(res, 404, 'Not found');

  try {
    const buf = await readFile(file);
    send(res, 200, buf, MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 500, 'Server error');
  }
});

await loadDb();
server.listen(PORT, BIND, () => {
  const lan = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('\n  Friday Quiz is running.\n');
  console.log('    Big screen:   http://localhost:' + PORT);
  if (BIND === '0.0.0.0') lan.forEach((ip) => console.log('    Phones:       http://' + ip + ':' + PORT));
  console.log('\n    Data:   ' + DATA_FILE);
  console.log('    Signup: ' + (INVITE_CODE ? 'invite code required' : 'open (no invite code set)'));
  console.log('    Stop with Ctrl+C\n');
});
