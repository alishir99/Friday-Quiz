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
import { lookup as dnsLookup } from 'node:dns/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Secrets (LLM_API_KEY) live in .env, not the shell, so `node server.mjs`
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
/* Overrides for when the automatic layout reads badly. Deliberately a short
   list of shapes rather than free placement: whatever is chosen still has to
   work on a projector and on somebody's phone. */
/* How much of the slide a picture takes, as a percentage of the screen's
   height. It used to be three presets and they were never the size anybody
   actually wanted, so it is a number the quiz maker drags now. The old three
   still read - a quiz written last month must not change shape today. */
const MEDIA_MIN = 15, MEDIA_MAX = 90, MEDIA_DEFAULT = 42;
const LEGACY_MEDIA_SIZE = { fit: 42, large: 62, fill: 86 };

function mediaSize(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.min(MEDIA_MAX, Math.max(MEDIA_MIN, Math.round(v)));
  }
  return LEGACY_MEDIA_SIZE[v] || MEDIA_DEFAULT;
}

/* A picture inside an option, sized separately from the question's. */
const OPTPIC_MIN = 6, OPTPIC_MAX = 40, OPTPIC_DEFAULT = 18;

function optionPicSize(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.min(OPTPIC_MAX, Math.max(OPTPIC_MIN, Math.round(v)));
  }
  return OPTPIC_DEFAULT;
}
const OPTION_LAYOUTS = ['auto', 'row', 'stacked'];
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

/* PULLING A PICTURE OFF A URL.

   Handy, and the single most dangerous thing in this file: the server is being
   asked to fetch an address somebody else chose. Left open that is a request
   forgery - the quiz maker types http://169.254.169.254/... and the box
   happily fetches its own cloud credentials and files them under this week's
   quiz. It runs on an Oracle VM where that address answers.

   So every hop is resolved first and every resolved address is checked. Only
   the quiz maker may ask, only http(s) is followed, redirects are counted, the
   read is capped and the whole thing is on a timer.

   The remaining hole is DNS rebinding: a name that passes the check and then
   resolves to something private when fetch() looks it up again a moment later.
   Closing it properly means dialling the IP by hand and carrying the Host
   header, which is a lot of machinery for a feature only the quiz maker can
   reach on a team server. Named rather than hidden. */
const FETCH_TIMEOUT = 10000;
const FETCH_MAX_HOPS = 3;
const FETCH_MAX_BYTES = 20 * 1024 * 1024;

function isBlockedAddress(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');           // IPv4 wearing an IPv6 hat
  const parts = v4.split('.');
  if (parts.length === 4 && parts.every((n) => /^\d+$/.test(n))) {
    const [a, b] = parts.map(Number);
    if (a === 0 || a === 10 || a === 127) return true;          // this host, private
    if (a === 169 && b === 254) return true;                    // link-local: the metadata service
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT
    if (a === 192 && b === 0) return true;                      // protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking
    if (a >= 224) return true;                                   // multicast and reserved
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd]/.test(v6)) return true;                            // unique local
  if (/^fe[89ab]/.test(v6)) return true;                         // link-local
  return false;
}

/* Every address the name answers to has to be allowed, not just the first:
   a host that returns one public and one private address would otherwise
   walk straight through. */
async function assertPublicHost(hostname) {
  let addrs;
  try {
    addrs = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error('That address does not resolve');
  }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new Error('That address is not one this server will fetch');
  }
}

/* A search results page is not a picture, and the commonest thing anybody will
   paste. Say so plainly rather than fetching a megabyte of HTML and reporting
   that it is not an image. */
function searchPageHint(u) {
  const host = u.hostname.replace(/^www\./, '');
  const isSearch = /^(google|bing|duckduckgo|yandex)\./.test(host)
    || host === 'images.google.com'
    || (host.endsWith('google.com') && u.pathname.startsWith('/search'));
  if (!isSearch) return null;
  return 'That is a search results page, not a picture. Open the image itself, '
    + 'then right-click it and copy the image address.';
}

async function fetchRemote(rawUrl, hops = 0) {
  if (hops > FETCH_MAX_HOPS) throw new Error('That address redirects too many times');

  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('That is not a web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be fetched');
  }
  const hint = searchPageHint(u);
  if (hint) throw new Error(hint);

  await assertPublicHost(u.hostname);

  const res = await fetch(u, {
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: {
      /* Says what it is. It used to open with a Mozilla token, on the theory
         that some hosts refuse an unnamed client - but a half-hearted spoof is
         worse than a name: Wikimedia rate-limits browser-shaped agents hard,
         and every picture pulled from there came back 429. Five in a row, same
         file: Mozilla token 429 every time, this one 200 every time. */
      'user-agent': 'FridayQuiz/1.0 (self-hosted pub quiz; +https://github.com/friday-quiz)',
      accept: 'image/*,text/html;q=0.8'
    }
  });

  // Follow it by hand, so the new address is checked like the first one was.
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    return fetchRemote(new URL(res.headers.get('location'), u).href, hops + 1);
  }
  if (!res.ok) throw new Error('That address answered ' + res.status);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > FETCH_MAX_BYTES) throw new Error('That file is too big');

  /* Read in chunks and stop at the cap. content-length is a claim, not a
     promise, and a server that lies about it could otherwise fill the disk. */
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > FETCH_MAX_BYTES) throw new Error('That file is too big');
    chunks.push(chunk);
  }
  return {
    url: u,
    mime: String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    body: Buffer.concat(chunks)
  };
}

/* The picture a page says represents it. Every share button on the internet
   reads this same tag, so it is what a news story or a Wikipedia article will
   hand back for the picture at the top. */
function ogImage(html, base) {
  const head = html.slice(0, 200000);            // it is a <head> tag; do not scan a novel
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m) {
      try { return new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch { /* keep looking */ }
    }
  }
  return null;
}

/* Extension back to content type, for serving uploaded media. */
const MEDIA_MIME = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([mime, m]) => [m.ext, mime])
);

/* database */

/* One install, several teams. Everything a team owns lives inside its own
   record: there is no expression anywhere that reaches another team's members
   without naming that team, which is the point. A flat users[] with a teamId
   on each row would read more easily but leaves every lookup one forgotten
   filter away from another team's data. */

const EMPTY_TEAM = (id, name) => ({
  id,
  name: name || 'Friday Quiz',
  code: '',           // quoted at sign-up; both authorises and picks the team
  masterId: null,     // quiz master: this team's admin. null until claimed
  users: [],          // { id, name, active, joinedAt, salt, hash }, or for a
                      // guest { id, name, active, joinedAt, guest: true }
  history: [],        // finished sessions
  upcoming: null,     // { id, date, quizMasterId, topicPickerId, reason, topic, quiz }
  live: null,         // running game
  revealMode: 'end',  // 'end' or 'each'; what the next game starts with
  rules: '',          // free text, editable by the quiz master only
  createdAt: new Date().toISOString()
});

const EMPTY = () => ({
  schema: 7,
  adminId: null,      // site admin, over the whole install. null until claimed
  teams: {},          // id -> team
  mediaTeam: {}       // media id -> the team that uploaded it
});

let db = EMPTY();
// token -> { userId, teamId }   (memory only; sign in again after a restart)
let tokens = new Map();

/* An install from before teams existed: everything at the top level. Recognised
   by shape rather than by `schema`, which was written but never read and so
   cannot be trusted to be accurate. Runs once - after it, `teams` exists. */
function isPreTeams(raw) {
  return !!raw && Array.isArray(raw.users) && !raw.teams;
}

function migrateToTeams(raw) {
  const id = uid();
  const team = EMPTY_TEAM(id, 'Friday Quiz');
  team.users = raw.users || [];
  team.history = raw.history || [];
  team.upcoming = raw.upcoming || null;
  team.revealMode = raw.revealMode || 'end';
  team.rules = raw.rules || '';
  /* Never leave this empty when the old install had a code, or sign-up falls
     open the moment the server restarts. */
  team.code = String(raw.inviteCode || INVITE_CODE || '').trim();
  // Whoever was admin keeps the team, and takes the install with it.
  team.masterId = raw.adminId || null;
  /* Files uploaded before teams existed have no owner recorded. They can only
     ever have belonged to this one team, so claim them - otherwise every
     picture in the history would stop loading. */
  const mediaTeam = {};
  const claim = (quiz) => mediaIdsIn(quiz).forEach((mid) => { mediaTeam[mid] = id; });
  claim(team.upcoming && team.upcoming.quiz);
  team.history.forEach((h) => claim(h.quiz));
  return { schema: 7, adminId: raw.adminId || null, teams: { [id]: team }, mediaTeam };
}

async function loadDb() {
  let raw = null;
  // No file yet, or an unreadable one: start empty and fall through, so a
  // fresh install still gets its first team below.
  try { raw = JSON.parse(await readFile(DATA_FILE, 'utf8')); } catch { raw = null; }

  if (!raw) {
    db = EMPTY();
  } else if (isPreTeams(raw)) {
    // Keep the old file untouched beside the new one. Cheap, and the only way
    // back if this ever goes wrong on someone's live install.
    try { await writeFile(DATA_FILE + '.pre-teams', JSON.stringify(raw, null, 2), 'utf8'); } catch {}
    db = migrateToTeams(raw);
    await persist();
  } else {
    db = { ...EMPTY(), ...raw };
  }

  /* A brand-new install still needs somewhere to sign up. One team, ready to
     go, so the app works out of the box exactly as it did before teams. */
  let fresh = false;
  if (!Object.keys(db.teams).length) {
    const id = uid();
    db.teams[id] = EMPTY_TEAM(id, 'Friday Quiz');
    fresh = true;
  }

  for (const team of Object.values(db.teams)) {
    // Never resume a half-finished game across a restart.
    team.live = null;
    /* The code used to live only in the environment. A fresh install with
       QUIZ_INVITE_CODE set adopts it, so the documented variable still works. */
    if (!team.code && INVITE_CODE) { team.code = INVITE_CODE; fresh = true; }
  }

  // Written after the loop, so the adopted code lands on disk with the team.
  if (fresh) await persist();
}

let writeChain = Promise.resolve();
function persist() {
  // A running game is memory-only, so it is stripped from every team on the
  // way to disk rather than from one top-level field as it used to be.
  const teams = {};
  for (const [id, t] of Object.entries(db.teams)) teams[id] = { ...t, live: null };
  const snapshot = JSON.stringify({ ...db, teams }, null, 2);
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

const teamById = (id) => (id && db.teams[id]) || null;
const teamList = () => Object.values(db.teams);

/* Every lookup names its team. Passing the wrong one returns nothing rather
   than somebody else's member, which is the failure mode we want. */
const userById = (team, id) => (team && team.users.find((u) => u.id === id)) || null;

// The install's owner, over every team.
const isSiteAdmin = (id) => !!db.adminId && db.adminId === id;
// This team's own admin.
const isTeamMaster = (id, team) => !!team && !!team.masterId && team.masterId === id;
// Guests play and score like everyone else, but never host and never admin.
const isGuest = (team, id) => { const u = userById(team, id); return !!(u && u.guest); };
/* Removed, not deleted. Their past quizzes still show their name - only
   `active: false` is ever written, so nothing that points at them breaks.
   Older records have no flag at all, which counts as present. */
const isRemoved = (team, id) => { const u = userById(team, id); return !!u && u.active === false; };
// Names and the invite code are matched loosely; passwords never are.
const sameCode = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/* The code in force. Stored in the database so the admin can change it from
   the app; the environment variable is only the starting value. */
const inviteCode = (team) => String((team && team.code) || '').trim();

/* No O/0 or I/1/l - this gets read off a screen across a room and typed on a
   phone, and those are the pairs people get wrong. 31^6 is around 900 million,
   which is a different league from a six-digit PIN. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(len = 6) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
const MAX_NAME = 40;
const MAX_RULES = 20000;
const MIN_PASSWORD = 4;

/* Quiz-writing assistant. Raw HTTPS rather than an SDK - this app has no
   npm install step at all, and that stays true for this too. DeepSeek has
   no hosted web-search tool the way some providers do, so unlike a
   search-backed assistant this one cannot cite live sources - it answers
   from what the model already knows, and is told to say so when unsure
   rather than inventing a confident-sounding fact. */
/* Which provider answers is a .env line, not a code change. DeepSeek, OpenAI,
   Groq, Together and most others all speak the same /chat/completions shape -
   same bearer header, same {model, messages} body, same choices[0].message.content
   coming back - so swapping one for another is a URL and a model name.
   Note the /v1 difference: OpenAI wants it in the path, DeepSeek does not. */
const LLM_URL = process.env.LLM_URL || 'https://api.deepseek.com/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
/* Either name works, so an existing .env keeps running untouched. */
const LLM_KEY = () => process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
/* Reasoning models (o3, gpt-5) reject max_tokens and want max_completion_tokens
   instead; everything else still takes max_tokens. Set this when you switch to
   one, or every request comes back 400. */
let LLM_MAX_TOKENS_FIELD = process.env.LLM_MAX_TOKENS_FIELD || 'max_tokens';
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

Move the right answer around. The example above happens to show 0, and it is very easy to leave every question that way - a quiz where the answer is always A is no quiz at all. Spread them across the whole range, so roughly a quarter land on each position in a four-option question.

About pictures and sound: you cannot make, find or attach a file - only the quiz master can, from their own machine. What you can do is say what each slot needs, and they will go and get it. "mediaHint" describes a file for the question itself; "optionHints" describes one per option, in the same order, empty string where nothing is needed. Keep each hint to a few words naming the file plainly - "a lion roaring, a few seconds" or "photograph of a badger". Only fill them in when the request actually calls for media, and leave them out entirely otherwise.

So for "guess the animal from the sound, with pictures to choose from", each question gets a "mediaHint" of the animal's call and four "optionHints" naming a photograph of each candidate animal, while "options" holds the animal names as the labels. Say plainly in your one-sentence reply that the files are theirs to add.

Match whatever tone is asked for - funny, serious, whatever. You have no way to check the web right now, so get facts as right as you can from what you already know, and if you are genuinely unsure of one, say so plainly in your one-sentence reply rather than presenting a guess as certain.

Never use an em dash (—) or an en dash (–), anywhere: not in questions, options, notes or your own replies. Where you would reach for one, use a comma, a colon, brackets, or start a new sentence. A plain hyphen in a compound word like "well-known" is fine.`;

/* Shuffle each question's options and follow the right answer to its new
   place. Belt and braces on top of asking the model nicely: left alone, an LLM
   will happily mark option A correct ten times out of ten, because that is
   what the example in its instructions shows. */
function spreadAnswers(quiz) {
  if (!quiz || !Array.isArray(quiz.questions)) return quiz;
  for (const q of quiz.questions) {
    if (!Array.isArray(q.options) || !Number.isInteger(q.correct)) continue;
    if (q.correct < 0 || q.correct >= q.options.length) continue;
    const right = q.options[q.correct];
    const hints = Array.isArray(q.optionHints) ? q.optionHints.slice() : null;
    // Fisher-Yates, carrying any per-option hint along with its option.
    const order = q.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomBytes(1)[0] % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    q.options = order.map((i) => q.options[i]);
    if (hints) q.optionHints = order.map((i) => hints[i] || '');
    q.correct = q.options.indexOf(right);
  }
  return quiz;
}

/* The prompt asks the model not to use dashes; this makes sure. Asking nicely
   is about as reliable here as it is for putting the answer somewhere other
   than A, and unlike a stray answer position a dash ends up on the projector
   and in the saved quiz for good. Spaced dashes become a comma, unspaced ones
   (a range, "1914—18") a plain hyphen. */
const noDashes = (s) => typeof s === 'string'
  ? s.replace(/(\d)\s*[—–]\s*(?=\d)/g, '$1-')   // a range stays a range: 1914-18, 10-20
     .replace(/\s+[—–]\s+/g, ', ')              // an aside becomes a comma
     .replace(/\s*[—–]\s*/g, '-')               // anything else, a plain hyphen
  : s;

function stripDashes(quiz) {
  if (!quiz) return quiz;
  for (const q of quiz.questions || []) {
    q.text = noDashes(q.text);
    q.note = noDashes(q.note);
    if (Array.isArray(q.options)) q.options = q.options.map(noDashes);
  }
  const tb = quiz.tieBreaker;
  if (tb) { tb.text = noDashes(tb.text); tb.note = noDashes(tb.note); tb.unit = noDashes(tb.unit); }
  return quiz;
}

function extractQuiz(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!m) return { reply: noDashes(text) || '(no reply)', quiz: null };
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && Array.isArray(parsed.questions) && parsed.questions.length) {
      const cleaned = noDashes((text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim());
      return { reply: cleaned || 'Here you go, take a look below.', quiz: stripDashes(spreadAnswers(parsed)) };
    }
  } catch {}
  return { reply: noDashes(text) || '(no reply)', quiz: null };
}

async function askAssistant(history, topic) {
  const apiKey = LLM_KEY();
  if (!apiKey) throw new Error('The assistant needs LLM_API_KEY set - put it in .env and restart the server');

  /* The topic is the brief, not a hint. Passed as "if it helps" the model
     treated it as background colour and cheerfully wrote a general knowledge
     round when asked for "the whole quiz" - which is the one request where the
     topic is the entire instruction. */
  const system = ASSIST_SYSTEM + (topic
    ? `\n\nThis week's topic is "${topic}". Every question you write is about it unless the quiz master plainly asks for something else, and a request with no subject of its own ("write the whole quiz", "give me a hard one") means this one. Go for the interesting corners of it rather than the first ten facts anybody would name, and vary what you ask: some recall, some odd-one-out, some dates or numbers. If the topic is broad, spread the questions across it; if it is narrow, go deeper rather than drifting off it. Same for the tiebreaker: it wants a number that belongs to this topic.`
    : '');

  const post = (tokensField) => fetch(LLM_URL, {
    method: 'POST',
    /* Without this a provider that stops answering hangs the request for ever,
       and the panel just sits there spinning. Ninety seconds is well past a
       slow ten-question generation and well short of anyone's patience. */
    signal: AbortSignal.timeout(90_000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      [tokensField]: 4096,
      messages: [{ role: 'system', content: system }, ...history]
    })
  });

  let field = LLM_MAX_TOKENS_FIELD;
  let res = await post(field);
  let body = await res.json();

  /* Reasoning models reject max_tokens and want max_completion_tokens. Rather
     than make whoever swaps the provider know that, take the provider at its
     word: it names the parameter it wants, so use it and try once more.
     Remembered for the rest of the run, so it costs one wasted call per
     restart rather than one per question. */
  if (!res.ok && field === 'max_tokens'
      && /max_completion_tokens/.test((body && body.error && body.error.message) || '')) {
    field = LLM_MAX_TOKENS_FIELD = 'max_completion_tokens';
    console.log('Assistant: this model wants max_completion_tokens; switching for the rest of this run.');
    res = await post(field);
    body = await res.json();
  }

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
  if (!iso || iso < today) return today;
  /* And never further out than the coming Friday. Finishing a quiz books the
     next one a week later, so a handful played in one afternoon march the date
     off into the future and it never walks back - which is how the board came
     to say September 4 in the middle of August. Nothing in the app schedules
     further ahead than the next Friday, so anything past it is drift. */
  const friday = nextFriday();
  return iso > friday ? friday : iso;
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
      mediaSize: MEDIA_DEFAULT, optionPicSize: OPTPIC_DEFAULT, optionLayout: 'auto',
      correct: null, note: '', media: null
    })),
    tieBreaker: { text: '', answer: null, unit: '', note: '', media: null }
  };
}

/* Keep only a media reference we wrote ourselves. The file name is rebuilt
   from the id and kind, so nothing the client sends can escape MEDIA_DIR. */
function cleanMedia(team, m) {
  if (!m || typeof m !== 'object') return null;
  const type = MEDIA_TYPES[m.mime];
  if (!type) return null;
  if (typeof m.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(m.id)) return null;
  /* Checking the shape of the id is not enough. Anyone could paste an id they
     saw elsewhere into a quiz and have the server accept it and serve it back,
     which is a file belonging to another team. It has to be ours. */
  if (!ownsMedia(team, m.id)) return null;
  return { id: m.id, kind: type.kind, mime: m.mime, name: String(m.name || '').slice(0, 120) };
}

const ownsMedia = (team, id) => !!team && db.mediaTeam[id] === team.id;

/* Every media id a quiz refers to. Used to give the files that already exist
   an owner at migration time, so the rule is the same for old and new. */
function mediaIdsIn(quiz) {
  const out = [];
  const take = (m) => { if (m && typeof m.id === 'string') out.push(m.id); };
  if (!quiz) return out;
  (quiz.questions || []).forEach((q) => {
    take(q.media);
    (q.optionMedia || []).forEach(take);
  });
  if (quiz.tieBreaker) take(quiz.tieBreaker.media);
  return out;
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
     lobby → topic → q0..q9 → tb → gap → a0..a9 → tba → board → roles
     Nobody learns anything until the end, so a wrong answer early does not
     take the wind out of the room.

   'each' (the Kahoot way)
     lobby → topic → q0 → a0 → q1 → a1 → … → q9 → a9 → tb → tba → board → roles
     Answer straight after each question, while people still remember it. */

/* 'topic' is a slide of its own between the lobby and the first question: the
   subject is a surprise until the quiz actually starts, so it deserves a
   moment rather than being glimpsed in the corner of question one. */
/* 'coin' only exists when two people finish dead level - see coinToss(). */
const PHASES = ['lobby', 'topic', 'q', 'tb', 'gap', 'a', 'tba', 'coin', 'board', 'roles'];
const REVEAL_MODES = ['end', 'each'];
const revealMode = (live) => (live && live.reveal === 'each') ? 'each' : 'end';

/* qCount is however many questions are in the quiz actually being played,
   not a fixed number: the quiz master can add more than the starting ten. */
function advance(live, qCount, coin) {
  const { phase, index } = live;
  const each = revealMode(live) === 'each';

  if (phase === 'lobby') { live.phase = 'topic'; live.index = 0; return; }
  if (phase === 'topic') { live.phase = 'q'; live.index = 0; return; }
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
  if (phase === 'tba') { live.phase = coin ? 'coin' : 'board'; return; }
  if (phase === 'coin') { live.phase = 'board'; return; }
  if (phase === 'board') { live.phase = 'roles'; return; }
}

function back(live, qCount, coin) {
  const { phase, index } = live;
  const each = revealMode(live) === 'each';

  if (phase === 'topic') { live.phase = 'lobby'; return; }
  if (phase === 'q') {
    if (each) {
      // The step before question n is the answer to n-1.
      if (index > 0) { live.phase = 'a'; live.index--; } else live.phase = 'topic';
      return;
    }
    if (index > 0) live.index--; else live.phase = 'topic';
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
  if (phase === 'coin') { live.phase = 'tba'; return; }
  if (phase === 'board') { live.phase = coin ? 'coin' : 'tba'; return; }
  if (phase === 'roles') { live.phase = 'board'; return; }
}

/* How many questions are in the quiz actually being (or just having been)
   played. db.upcoming.quiz is null once the week has rolled over, so once
   the result is committed the frozen count on live.final is the only
   accurate source left. */
function liveQuestionCount(team, live) {
  if (live && live.final) return live.final.questionCount;
  const up = team && team.upcoming;
  return (up && up.quiz && up.quiz.questions.length) || QUESTION_COUNT;
}

const DONE_PHASES = ['tba', 'coin', 'board', 'roles'];

/* How many answers are public, counting from the first question. Both modes
   walk the reveal forward one question at a time - the ones still to come stay
   off the wire, otherwise revealing question one hands devtools the rest of
   the quiz, and a running score would be a final score from the first slide.

   The two modes differ only in where the walk starts. 'each' has already shown
   every answer up to the question on screen; 'end' has shown none of them
   until the run of answer slides begins. */
function revealedCount(live, qCount) {
  if (!live) return 0;
  if (DONE_PHASES.includes(live.phase)) return qCount;
  if (live.phase === 'a') return live.index + 1;         // this one included
  if (revealMode(live) === 'each') {
    if (['tb', 'gap'].includes(live.phase)) return qCount;
    return live.index;                       // on 'q': everything before it
  }
  return 0;                                  // 'end': nothing until the 'a' run
}

/* scoring */

function scoreFor(userId, quiz, live) {
  const mine = live.answers[userId] || {};
  let score = 0;
  quiz.questions.forEach((q, i) => { if (mine[i] === q.correct) score++; });
  return score;
}

/* Everyone who played, best first, before the coin has had its say. */
function rankRows(team) {
  const live = team && team.live;
  const quiz = team.upcoming && team.upcoming.quiz;
  if (!live || !quiz) return [];
  const tieAnswer = Number(quiz.tieBreaker.answer);
  const hosted = {};
  team.history.forEach((s) => { hosted[s.quizMasterId] = (hosted[s.quizMasterId] || 0) + 1; });

  const masterId = team.upcoming.quizMasterId;
  const rows = live.players
    .filter((id) => id !== masterId)
    .map((id) => {
      const u = userById(team, id);
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

  rows.forEach((r, i) => { r.place = i + 1; });
  return rows;
}

const SIDES = ['heads', 'tails'];

/* THE TOSS.

   The wooden spoon writes next Friday's quiz; whoever finished just above them
   picks the topic. When those two finish dead level - same score, and the same
   distance out on the tiebreaker - there is nothing left to say which of them
   takes which job. The old answer (whoever had hosted fewer quizzes, then
   alphabetical order) settled it quietly and settled it the same way every
   time. That is a habit, not a tiebreak. So they call it and the room watches
   a coin land.

   Only ever the bottom two, and only ever two: this exists to hand out those
   two jobs. Three level at the bottom is a raffle, and no coin settles that.

   Nothing is decided here - live.coin holds the calls and, once the quiz maker
   has actually flipped it, the result. This function runs on every push, so it
   must never be the thing that decides: a coin that lands somewhere new forty
   times a second is not a coin. */
function coinToss(team) {
  const live = team && team.live;
  if (!live) return null;
  if (live.final) return live.final.coin || null;

  // Only the people actually in line for the jobs. A guest is here for one
  // night and never inherits the quiz, so a guest cannot be in the toss.
  const rows = rankRows(team).filter((r) => !isGuest(team, r.userId) && !isRemoved(team, r.userId));
  const level = (a, b) => !!a && !!b && a.score === b.score && a.diff === b.diff;
  const spoon = rows[rows.length - 1], above = rows[rows.length - 2];

  if (!level(above, spoon) || level(rows[rows.length - 3], above)) {
    live.coin = null;
    return null;
  }

  const pair = [above, spoon];
  // Keyed on who is tied, so a late answer that changes the pair starts over.
  const key = pair.map((r) => r.userId).join('|');
  if (!live.coin || live.coin.key !== key) live.coin = { key, calls: {}, result: null };

  const calls = live.coin.calls, result = live.coin.result;
  const won = result ? pair.find((r) => calls[r.userId] === result) : null;
  const lost = won ? pair.find((r) => r.userId !== won.userId) : null;

  return {
    key,
    result,
    winnerId: won ? won.userId : null,      // picks the topic
    loserId: lost ? lost.userId : null,     // writes the quiz
    players: pair.map((r) => ({
      userId: r.userId, name: r.name, score: r.score, call: calls[r.userId] || null
    }))
  };
}

function rankLive(team) {
  const live = team && team.live;
  // Once the week is committed the ranking is frozen. upcoming has already
  // rolled over to a blank next Friday and can no longer be re-scored.
  if (live && live.final) return live.final.ranking;

  const rows = rankRows(team);
  const toss = coinToss(team);
  /* Whoever lost the toss takes the lower place - the wooden spoon is the one
     writing next week's quiz, and the board has to say so. Anyone sitting
     between them scored the same, so nobody is stepped over. */
  if (toss && toss.loserId) {
    const w = rows.findIndex((r) => r.userId === toss.winnerId);
    const l = rows.findIndex((r) => r.userId === toss.loserId);
    if (w > -1 && l > -1 && w > l) {
      [rows[w], rows[l]] = [rows[l], rows[w]];
      rows.forEach((r, i) => { r.place = i + 1; });
    }
  }
  return rows;
}

/* Everyone's tiebreaker guess, closest first, so the room can see who was
   nearest. Only ever built once the answer is on the screen. */
function tieRows(team) {
  const live = team && team.live;
  if (!live) return null;

  if (live.final) {
    return live.final.ranking.map((r) => ({
      userId: r.userId, name: r.name,
      guess: r.tieGuess === undefined ? null : r.tieGuess,
      diff: Number.isFinite(r.diff) ? r.diff : null
    })).sort(byNearest);
  }

  const quiz = team.upcoming && team.upcoming.quiz;
  if (!quiz) return null;
  const answer = Number(quiz.tieBreaker.answer);
  const masterId = team.upcoming.quizMasterId;

  return live.players
    .filter((id) => id !== masterId)
    .map((id) => {
      const u = userById(team, id);
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

function deriveRoles(team, rows) {
  // A guest can finish last without inheriting next week's quiz - they are
  // here for one night and may never come back.
  const eligible = rows.filter((r) => !isGuest(team, r.userId) && !isRemoved(team, r.userId));
  if (!eligible.length) {
    // Only guests played. Leave next week exactly as it stands rather than
    // handing the quiz to someone who cannot write it.
    return {
      quizMasterId: team.upcoming ? team.upcoming.quizMasterId : null,
      topicPickerId: team.upcoming ? team.upcoming.topicPickerId : null,
      reason: { master: 'No one new to hand it to', picker: 'No one new to hand it to' }
    };
  }
  const last = eligible[eligible.length - 1];
  const toss = coinToss(team);
  // True when these two are the pair a coin has just separated.
  const byCoin = !!(toss && toss.loserId && toss.loserId === last.userId);
  /* Whoever won never gets a job. With only two playing, "second from last" is
     the winner, so the wooden spoon took the quiz and handed the topic to the
     person who had just beaten them. Below three, one person takes both -
     unless a coin split them, in which case neither of them beat the other and
     the two jobs go one each, which is the entire point of having tossed. */
  const second = (eligible.length > 2 || byCoin) ? eligible[eligible.length - 2] : last;
  const qCount = liveQuestionCount(team, team.live);
  return {
    quizMasterId: last.userId,
    topicPickerId: second.userId,
    reason: {
      master: byCoin
        ? `Lost the toss, level on ${last.score}/${qCount}`
        : `Finished last (${last.score}/${qCount})`,
      picker: byCoin
        ? `Won the toss, level on ${second.score}/${qCount}`
        : `Finished second from last (${second.score}/${qCount})`
    }
  };
}

/* How many of the answers shown so far this player got right. Bounded by
   `revealed`, so it can never run ahead of what is on the screen. */
function myScoreSoFar(team, live, userId, revealed) {
  const quiz = team.upcoming && team.upcoming.quiz;
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
      optionMedia: q.optionMedia || null, media: q.media || null,
      // How it should be laid out is not a secret, and the slide needs it.
      mediaSize: mediaSize(q.mediaSize), optionPicSize: optionPicSize(q.optionPicSize),
      optionLayout: q.optionLayout || 'auto'
    })),
    tieBreaker: tieRevealed ? { ...quiz.tieBreaker } : {
      text: quiz.tieBreaker.text,
      unit: quiz.tieBreaker.unit,
      media: quiz.tieBreaker.media || null
    }
  };
}

function stateFor(userId, team) {
  const up = team.upcoming;
  const isMaster = !!up && up.quizMasterId === userId;
  const isPicker = !!up && up.topicPickerId === userId;
  const live = team.live;
  /* Only the quiz master holds the whole answer sheet. Everybody else is
     handed exactly what has been shown, counted by revealedCount() - one gate
     for both modes, so 'end' can no longer post the lot the moment the answer
     slides begin. */
  const canSeeAnswers = isMaster;
  const qCount = liveQuestionCount(team, live);
  const revealed = isMaster ? qCount : revealedCount(live, qCount);
  const tieRevealed = isMaster || (!!live && DONE_PHASES.includes(live.phase));
  // The topic is a surprise for the rest of the team: the picker chose it and
  // the quiz master has to write to it, nobody else needs to know. It stops
  // being a secret once the quiz actually starts and it goes up on the big
  // screen - but not in the lobby, which is precisely when the quiz master is
  // sharing their screen and waiting for people to scan in.
  const canSeeTopic = isMaster || isPicker || (!!live && live.phase !== 'lobby');

  const online = onlineIds(team.id);
  const out = {
    team: { id: team.id, name: team.name },
    users: team.users.map((u) => ({ id: u.id, name: u.name, active: u.active, guest: !!u.guest, online: online.has(u.id) })),
    /* Every past quiz's questions used to ride along here - and this whole
       object is rebuilt and pushed to every connected phone on every answer.
       After a year that was a megabyte per player per keystroke. The list and
       the all-time table only need the rankings; the questions are fetched
       from /api/history/<id>/quiz when someone actually opens one. */
    history: team.history.map(({ quiz, ...rest }) => ({
      ...rest,
      questionCount: quiz && quiz.questions ? quiz.questions.length : QUESTION_COUNT
    })),
    // The team's own admin. `siteAdmin` is a flag, not an id: who runs the
    // whole install is nobody else's business.
    adminId: team.masterId,
    siteAdmin: isSiteAdmin(userId),
    /* Members can read it, so anyone on the team can invite someone. Guests
       cannot: the code is what turns a one-night nickname into a permanent
       account, and handing it to them would defeat the point of having it. */
    inviteCode: isGuest(team, userId) ? null : (inviteCode(team) || ''),
    rules: team.rules,
    // What the next game will do, set from the dashboard before kick-off.
    revealMode: REVEAL_MODES.includes(team.revealMode) ? team.revealMode : 'end',
    upcoming: up ? {
      ...up,
      /* Today, plainly. This is the date on the dashboard and on the lobby
         slide, and it is read as "what day is this happening" - so on a
         Thursday it has to say Thursday, whatever Friday the rota booked.
         The booking itself still lives in up.date and still drives the rota;
         it is only what gets shown that follows the calendar. */
      date: todayISO(),
      topic: canSeeTopic ? up.topic : '',
      // Everyone still sees *that* a topic has been picked, just not what it is.
      topicSet: !!String(up.topic || '').trim(),
      quiz: visibleQuiz(up.quiz, canSeeAnswers, canSeeTopic, revealed, tieRevealed),
      quizReady: quizReady(up.quiz)
    } : null,
    live: null,
    me: userId
  };

  if (live) {
    const mine = live.answers[userId] || {};
    const masterId = live.final ? live.final.quizMasterId : (up && up.quizMasterId);
    const others = live.players.filter((p) => p !== masterId);
    const ranking = ['board', 'roles'].includes(live.phase) ? rankLive(team) : null;
    /* The toss for the two jobs. Sent from 'tba' so the quiz maker's Next
       button can say what is coming; nothing is held back, because until they
       actually flip it there is no result to hold back. */
    const toss = ['tba', 'coin', 'board', 'roles'].includes(live.phase) ? coinToss(team) : null;

    out.live = {
      id: live.id,
      phase: live.phase,
      index: live.index,
      // Held back in the lobby the same way the answers are - a player with
      // devtools should not be able to read it off the wire either.
      topic: canSeeTopic ? (live.final ? live.final.topic : (up ? up.topic : '')) : '',
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
      myScore: myScoreSoFar(team, live, userId, revealed),
      // Held back until the tiebreaker answer is up, like the answers are.
      tieRows: DONE_PHASES.includes(live.phase) ? tieRows(team) : null,
      ranking,
      nextRoles: live.phase === 'roles'
        ? (live.final ? live.final.roles : (live.roleOverride || deriveRoles(team, rankLive(team))))
        : null,
      coin: toss,
      // How far the quiz has got, and how far the answers have: -1 for neither.
      // Together these are what closes a question the slides have gone back to.
      asked: live.asked ?? -1,
      shown: live.shown ?? -1,
      questionCount: qCount,
      reveal: revealMode(live),
      // Stepped out. The client stops taking the screen over and offers a way
      // back in; everyone else's counts already exclude them.
      iLeft: (live.left || []).includes(userId),
      committed: !!live.committed
    };
  }
  return out;
}

/* Someone joins the room. The one door in, so a player who has stepped out
   stays out until they say otherwise - a reconnecting phone, a late answer and
   the lobby all used to push straight into players and undo the leaving. */
function joinLive(live, userId) {
  if (!live) return;
  if ((live.left || []).includes(userId)) return;
  if (!live.players.includes(userId)) live.players.push(userId);
}

/* real-time push (SSE) */

const clients = new Set();       // { res, userId, teamId }, one per open tab

// Who has a live connection right now, not "whose account still exists".
// A person can have several tabs open; they only count once.
function onlineIds(teamId) {
  const ids = new Set();
  for (const c of clients) if (c.teamId === teamId) ids.add(c.userId);
  return ids;
}

/* The one place a push leaves the server. Every caller names the team it is
   pushing about, and clients outside it are never written to - twenty call
   sites each remembering to filter is how one team ends up watching another
   team's quiz. Passing nothing is a bug, not "send to everyone". */
function broadcast(team) {
  if (!team || !team.id) throw new Error('broadcast() needs a team');
  for (const c of clients) {
    if (c.teamId !== team.id) continue;
    try {
      c.res.write(`data: ${JSON.stringify(stateFor(c.userId, team))}\n\n`);
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
/* A session is a user *and* the team they signed into. One team per account,
   so this is decided once at sign-in and never changes for the life of the
   token. Tokens are memory-only, so there is nothing to migrate. */
const whoami = (req) => tokens.get(cookieToken(req)) || null;

/* Behind a TLS proxy the app itself still speaks plain HTTP, so the header is
   the only way to know the browser is on HTTPS. Spoofing it only adds Secure
   to the attacker's own cookie, so it does not need to be trusted carefully. */
const isHttps = (req) =>
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function setTokenCookie(userId, teamId, secure) {
  const token = randomBytes(24).toString('hex');
  tokens.set(token, { userId, teamId });
  return `fq_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}`
    + (secure ? '; Secure' : '');
}

/* Make sure there is always something for the next Friday. */
function ensureUpcoming(team) {
  if (!team || team.upcoming) return;
  // Seed from members only - a guest who happens to arrive first should not
  // end up owning the first Friday.
  const members = team.users.filter((u) => !u.guest && u.active !== false);
  if (members.length < 2) return;
  const [a, b] = members;
  team.upcoming = {
    id: uid(), date: nextFriday(), quizMasterId: a.id, topicPickerId: b.id,
    reason: { master: 'First quiz of the season', picker: 'First quiz of the season' },
    topic: '', quiz: null
  };
}

/* routes */

async function api(req, res, path) {
  const session = whoami(req);
  const me = session ? session.userId : null;
  /* The team this request is about. Everything below reads it rather than any
     global, so a handler cannot accidentally act on somebody else's team. */
  const team = session ? teamById(session.teamId) : null;
  const requireUser = () => {
    if (!me || !team) { json(res, 401, { error: 'Please sign in' }); return null; }
    return me;
  };
  const isMaster = () => !!team && !!team.upcoming && team.upcoming.quizMasterId === me;
  // Whoever started the running game keeps the controls, even after the
  // results are saved and the role has already passed to someone else.
  const runsLive = () => !!team && !!team.live &&
    me === (team.live.final ? team.live.final.quizMasterId : (team.upcoming && team.upcoming.quizMasterId));

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
    /* Which team? Names are only unique within one, so the same "Ali" can
       exist in several. Look for them everywhere: one match signs straight in,
       which is the ordinary case. Several, and we have to ask which team -
       the code settles it. Guests are invisible here on purpose: a guest record
       has no hash, so matching one would drop into the "account predates
       passwords" branch below and adopt it, handing over an account without
       ever asking for the code. */
    const named = (t) => t.users.find((u) => !u.guest && u.name.toLowerCase() === clean.toLowerCase());
    let hits = teamList().filter(named);
    const quoted = String(invite || '').trim();
    if (quoted) hits = hits.filter((t) => sameCode(quoted, t.code));

    if (hits.length > 1) {
      return json(res, 409, {
        error: 'That name is on more than one team. Add your team’s code.',
        needTeam: true
      });
    }

    let signInTeam = hits[0] || null;
    let user = signInTeam ? named(signInTeam) : null;

    if (!user) {
      /* Nobody by that name, so this is a new account and the code decides
         which team it joins. On a public URL sign-up is the whole perimeter:
         without a code anyone who finds the address could make an account and,
         if nobody has claimed it yet, take admin.

         Case and stray spaces are forgiven - it is a phrase passed round by
         word of mouth and arrives capitalised however the sender felt. It is a
         gate against strangers, not a password. Passwords stay exact. */
      const gated = teamList().filter((t) => inviteCode(t));
      signInTeam = quoted ? teamList().find((t) => sameCode(quoted, t.code)) : null;
      if (!signInTeam) {
        // A single team with no code set at all means an open install.
        const open = teamList().filter((t) => !inviteCode(t));
        if (!gated.length && open.length === 1) signInTeam = open[0];
      }
      if (!signInTeam) {
        return json(res, 403, {
          error: quoted
            ? 'That code does not match any team.'
            : 'New here? You need the code from whoever runs your quiz.',
          needInvite: true
        });
      }
      const { salt, hash } = hashPassword(pass);
      user = { id: uid(), name: clean, active: true, joinedAt: new Date().toISOString(), salt, hash };
      signInTeam.users.push(user);
      ensureUpcoming(signInTeam);
      await persist();
      broadcast(signInTeam);
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
      { 'set-cookie': setTokenCookie(user.id, signInTeam.id, isHttps(req)) });
  }

  /* A nickname and nothing else, for someone who is here for one night. No
     password and no invite code: the barrier for a guest is knowing the quiz
     is happening. They play and score like anyone else but never host and
     never take admin - see isGuest() at the top. */
  if (path === '/api/join' && req.method === 'POST') {
    const { name, invite } = await readBody(req);
    const clean = String(name || '').trim().slice(0, MAX_NAME);
    if (!clean) return json(res, 400, { error: 'Enter a name' });

    /* Which quiz are they walking into? A code names it. With only one team on
       the install there is nothing to choose, so it stays as open as it was. */
    const quoted = String(invite || '').trim();
    const all = teamList();
    const guestTeam = quoted ? all.find((t) => sameCode(quoted, t.code)) : (all.length === 1 ? all[0] : null);
    if (!guestTeam) {
      return json(res, 403, {
        error: quoted ? 'That code does not match any team.' : 'You need the code for today’s quiz.',
        needTeam: true
      });
    }

    // Guests may share a name with each other, but not with the team - a
    // stranger should not be able to appear on the board as a teammate.
    if (guestTeam.users.some((u) => !u.guest && u.active !== false && u.name.toLowerCase() === clean.toLowerCase())) {
      return json(res, 409, { error: 'Someone on the team goes by that name. Try another.' });
    }
    /* Always a fresh account, even for a repeated name. With no password
       there is no way to prove you are the same guest as last time, so the
       safe reading of "Sam joins again" is that it is a different Sam. */
    const user = { id: uid(), name: clean, active: true, guest: true, joinedAt: new Date().toISOString() };
    guestTeam.users.push(user);
    ensureUpcoming(guestTeam);
    await persist();
    broadcast(guestTeam);
    return json(res, 200, { ok: true, me: user.id },
      { 'set-cookie': setTokenCookie(user.id, guestTeam.id, isHttps(req)) });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    tokens.delete(cookieToken(req));
    return json(res, 200, { ok: true }, { 'set-cookie': 'fq_token=; HttpOnly; Path=/; Max-Age=0' });
  }

  /* Self-service: change your own password while signed in. */
  if (path === '/api/change-password' && req.method === 'POST') {
    if (!requireUser()) return;
    const { oldPassword, newPassword } = await readBody(req);
    const user = userById(team, me);
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
    if (!isTeamMaster(me, team)) return json(res, 403, { error: 'Only the quiz master can reset a password' });
    const { userId } = await readBody(req);
    const user = userById(team, userId);
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
    if (isGuest(team, me)) return json(res, 403, { error: 'Guests cannot run a team' });
    if (team.masterId) return json(res, 409, { error: 'There is already an admin' });
    team.masterId = me;
    /* Quiz master of this team, and that is usually all. Running the install
       is a different job, and a stranger who signs up to a team they were
       given a code for must not be able to take it. Only the very first claim
       on a brand new install, when there is one team and nobody in charge of
       anything, also takes the install itself. */
    if (!db.adminId && teamList().length === 1) db.adminId = me;
    await persist(); broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* Teams. Only the site admin, who owns the install; a quiz master runs one
     team and has no business knowing the others exist. */
  if (path === '/api/teams' && req.method === 'GET') {
    if (!requireUser()) return;
    if (!isSiteAdmin(me)) return json(res, 403, { error: 'Only the site admin can see the teams' });
    return json(res, 200, {
      ok: true,
      teams: teamList().map((t) => ({
        id: t.id, name: t.name, code: t.code,
        played: t.history.length,
        masterId: t.masterId,
        masterName: (userById(t, t.masterId) || {}).name || null,
        mine: !!team && t.id === team.id,
        // Enough to draw each team's own roster without a second round trip.
        users: t.users.map((u) => ({
          id: u.id, name: u.name, guest: !!u.guest, active: u.active !== false
        }))
      }))
    });
  }

  /* Renaming a team. The quiz master owns the name; the site admin can fix
     any of them. */
  if (path === '/api/teams/name' && req.method === 'POST') {
    if (!requireUser()) return;
    const { teamId, name } = await readBody(req);
    const target = teamId ? teamById(teamId) : team;
    if (!target) return json(res, 400, { error: 'No such team' });
    if (!isTeamMaster(me, target) && !isSiteAdmin(me)) {
      return json(res, 403, { error: 'Only the quiz master can rename the team' });
    }
    const clean = String(name || '').trim().slice(0, MAX_NAME);
    if (!clean) return json(res, 400, { error: 'Give the team a name' });
    target.name = clean;
    await persist(); broadcast(target);
    return json(res, 200, { ok: true, name: target.name });
  }

  /* Which team does this code belong to? Answered before sign-in so somebody
     typing a code can see whose quiz they are about to walk into. It only ever
     tells you a name you already had the code for. */
  if (path === '/api/team-for-code' && req.method === 'POST') {
    const { code } = await readBody(req);
    const quoted = String(code || '').trim();
    const hit = quoted ? teamList().find((t) => sameCode(quoted, t.code)) : null;
    return json(res, 200, { ok: true, name: hit ? hit.name : null });
  }

  if (path === '/api/teams' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isSiteAdmin(me)) return json(res, 403, { error: 'Only the site admin can add a team' });
    const { name, code } = await readBody(req);
    const clean = String(name || '').trim().slice(0, MAX_NAME);
    if (!clean) return json(res, 400, { error: 'Give the team a name' });
    const wanted = String(code || '').trim().slice(0, 80) || makeCode();
    // Two teams sharing a code would make sign-up ambiguous.
    if (teamList().some((t) => sameCode(wanted, t.code))) {
      return json(res, 409, { error: 'Another team already uses that code' });
    }
    const id = uid();
    const made = EMPTY_TEAM(id, clean);
    made.code = wanted;
    db.teams[id] = made;
    await persist();
    return json(res, 200, { ok: true, team: { id, name: made.name, code: made.code } });
  }

  /* Removing a team takes its members, history and rota with it. The whole
     record is written out beside the database first: this is the one action
     here with nothing else to undo it. */
  if (path === '/api/teams/remove' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isSiteAdmin(me)) return json(res, 403, { error: 'Only the site admin can remove a team' });
    const { teamId } = await readBody(req);
    const doomed = teamById(teamId);
    if (!doomed) return json(res, 400, { error: 'No such team' });
    if (team && doomed.id === team.id) {
      return json(res, 400, { error: 'That is the team you are signed in to' });
    }
    if (teamList().length < 2) return json(res, 400, { error: 'That is the only team' });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await writeFile(join(DATA_DIR, `removed-team-${doomed.name.replace(/[^a-z0-9]+/gi, '-')}-${stamp}.json`),
        JSON.stringify(doomed, null, 2), 'utf8');
    } catch (e) {
      return json(res, 500, { error: 'Could not write the backup, so nothing was removed' });
    }
    // Sign its people out; their accounts are gone with the team.
    for (const [token, sess] of tokens) if (sess.teamId === doomed.id) tokens.delete(token);
    delete db.teams[doomed.id];
    await persist();
    return json(res, 200, { ok: true, name: doomed.name });
  }

  /* The invite code, changeable without a trip to the server. Send a code to
     set your own, or nothing to have one made up. */
  if (path === '/api/invite' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isTeamMaster(me, team)) return json(res, 403, { error: 'Only the quiz master can change this' });
    const { code } = await readBody(req);
    const wanted = String(code == null ? '' : code).trim().slice(0, 80);
    if (code !== undefined && code !== null && !wanted) {
      // An explicit empty string means "let anyone sign up", which is a real
      // choice on a trusted network but worth being deliberate about.
      team.code = '';
    } else {
      team.code = wanted || makeCode();
    }
    await persist(); broadcast(team);
    return json(res, 200, { ok: true, inviteCode: team.code });
  }

  /* Removing someone. A flag rather than a delete: every past quiz they played
     still lists them, and the scoreboards keep working. They cannot sign in,
     do not appear on the team, and are out of the rota - but nothing that
     points at them dangles, and putting them back is one click. */
  if (path === '/api/admin/set-active' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isTeamMaster(me, team)) return json(res, 403, { error: 'Only the quiz master can do this' });
    const { userId, active } = await readBody(req);
    const target = userById(team, userId);
    if (!target) return json(res, 400, { error: 'No such person' });

    if (active === false) {
      /* Only two people cannot be removed: you, and whoever runs the team -
         both would lock somebody out of their own controls. Holding next
         week's duty is not a reason to refuse; it just gets handed on. */
      if (userId === me) return json(res, 400, { error: 'You cannot remove yourself' });
      if (isTeamMaster(userId, team)) {
        return json(res, 400, { error: 'Pass the quiz master role on first' });
      }
      target.active = false;

      /* If they were down to write or pick next week, give the job to someone
         still here rather than leaving it pointing at a removed account. */
      const up = team.upcoming;
      if (up) {
        const free = team.users.filter((u) =>
          !u.guest && u.active !== false && u.id !== up.quizMasterId && u.id !== up.topicPickerId);
        const spare = () => { const u = free.shift(); return u ? u.id : null; };
        if (up.quizMasterId === userId) {
          up.quizMasterId = spare() || team.masterId || null;
          up.reason = { ...(up.reason || {}), master: 'Handed on when ' + target.name + ' was removed' };
        }
        if (up.topicPickerId === userId) {
          up.topicPickerId = spare() || team.masterId || null;
          up.reason = { ...(up.reason || {}), picker: 'Handed on when ' + target.name + ' was removed' };
        }
      }
      // Out of the room, and out of any game already running.
      for (const [token, uid_] of tokens) if (uid_ === userId) tokens.delete(token);
      if (team.live) team.live.players = team.live.players.filter((p) => p !== userId);
    } else {
      target.active = true;
    }
    await persist(); broadcast(team);
    return json(res, 200, { ok: true, active: target.active });
  }

  /* Handing over the server itself. Distinct from passing a team on: this is
     who may create teams and see them all. Without it the very first claim on
     an install would own it forever, with no way to leave. */
  if (path === '/api/site-admin/transfer' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isSiteAdmin(me)) return json(res, 403, { error: 'Only the site admin can hand the server on' });
    const { userId } = await readBody(req);
    // The new owner can be on any team, but has to be a real, present member.
    const target = teamList().map((t) => userById(t, userId)).find(Boolean);
    if (!target) return json(res, 400, { error: 'No such person' });
    if (target.guest) return json(res, 400, { error: 'Guests cannot run the server' });
    if (target.active === false) return json(res, 400, { error: 'That person has been removed' });
    db.adminId = userId;
    await persist();
    for (const t of teamList()) broadcast(t);   // the pill moves on every team
    return json(res, 200, { ok: true });
  }

  if (path === '/api/admin/transfer' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isTeamMaster(me, team)) return json(res, 403, { error: 'Only the quiz master can do this' });
    const { userId } = await readBody(req);
    if (!userById(team, userId)) return json(res, 400, { error: 'No such person' });
    if (isGuest(team, userId)) return json(res, 400, { error: 'Guests cannot run a team' });
    if (isRemoved(team, userId)) return json(res, 400, { error: 'That person has been removed' });
    // Hands over this team. Who owns the install is a separate question.
    team.masterId = userId;
    await persist(); broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* A page of house rules, visible to everyone, editable only by the admin. */
  if (path === '/api/rules' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isTeamMaster(me, team)) return json(res, 403, { error: 'Only the admin can edit this' });
    const { text } = await readBody(req);
    team.rules = String(text || '').slice(0, MAX_RULES);
    await persist(); broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* One past quiz's questions and answers, fetched only when someone opens
     it. Safe to hand over: the game is long finished. */
  const pastQuiz = path.match(/^\/api\/history\/([a-f0-9]+)\/quiz$/);
  if (pastQuiz && req.method === 'GET') {
    if (!requireUser()) return;
    /* Searched inside this team only. It used to look across the whole
       install, so any signed-in person could fetch any past quiz by id. */
    const past = team.history.find((h) => h.id === pastQuiz[1]);
    if (!past || !past.quiz) return json(res, 404, { error: 'No such quiz' });
    return json(res, 200, { ok: true, quiz: past.quiz });
  }

  if (path === '/api/state' && req.method === 'GET') {
    if (!me || !team) {
      const anyUsers = teamList().some((t) => t.users.length > 0);
      return json(res, 200, { anonymous: true, anyUsers });
    }
    return json(res, 200, stateFor(me, team));
  }

  /* Live updates */

  if (path === '/api/events') {
    if (!me || !team) return json(res, 401, { error: 'Please sign in' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(stateFor(me, team))}\n\n`);
    const client = { res, userId: me, teamId: team.id };
    clients.add(client);
    // Opening the app during a game is what joining means - this is what the
    // lobby counts. Once in, you stay in: a phone locking should not drop you.
    if (team.live && !isRemoved(team, me)) joinLive(team.live, me);
    broadcast(team);      // tell everyone else this person just came online
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(beat); clients.delete(client); broadcast(team); });
    return;
  }

  /* Setting up the week */

  if (path === '/api/topic' && req.method === 'POST') {
    if (!requireUser()) return;
    const { topic } = await readBody(req);
    if (!team.upcoming) return json(res, 400, { error: 'Nothing scheduled' });
    if (me !== team.upcoming.topicPickerId && !isMaster()) {
      return json(res, 403, { error: 'Only the topic picker can set this' });
    }
    team.upcoming.topic = String(topic || '').trim();
    if (team.upcoming.quiz) team.upcoming.quiz.topic = team.upcoming.topic;
    await persist(); broadcast(team);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/quiz' && req.method === 'PUT') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz maker can write the quiz' });
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
      const optionMedia = options.map((_, i) => cleanMedia(team, src[i]));
      const size = mediaSize(q.mediaSize);
      const optPic = optionPicSize(q.optionPicSize);
      const optionLayout = OPTION_LAYOUTS.includes(q.optionLayout) ? q.optionLayout : 'auto';
      return { ...q, options, optionMedia, correct, mediaSize: size, optionPicSize: optPic, optionLayout,
               media: cleanMedia(team, q.media) };
    });
    if (quiz.tieBreaker) quiz.tieBreaker.media = cleanMedia(team, quiz.tieBreaker.media);
    team.upcoming.quiz = { ...quiz, authorId: me, topic: team.upcoming.topic };
    await persist(); broadcast(team);
    return json(res, 200, { ok: true, ready: quizReady(team.upcoming.quiz) });
  }

  /* Media upload. The body is the raw file, the type comes from the header,
     which avoids hand-rolling a multipart parser for no benefit. */
  /* The same thing as an upload, only the file comes off the web. Stored and
     owned exactly like one, so everything downstream - the ownership check,
     the serving, the history - carries on not caring where it came from. */
  if (path === '/api/media/from-url' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz maker can add media' });

    const { url } = await readBody(req);
    if (!url || typeof url !== 'string') return json(res, 400, { error: 'No address given' });

    let got;
    try {
      got = await fetchRemote(url.trim());

      /* A page rather than a file: read the picture it says represents it.
         Only one step - if that picture is itself a page, something is wrong
         and guessing further would just be fetching the web at random. */
      if (got.mime.startsWith('text/html')) {
        const found = ogImage(got.body.toString('utf8'), got.url.href);
        if (!found) {
          return json(res, 415, {
            error: 'That page does not offer a picture. Right-click the image itself '
                 + 'and copy the image address.'
          });
        }
        got = await fetchRemote(found);
      }
    } catch (e) {
      // These messages are written to be read by the quiz maker, so pass them on.
      return json(res, 400, { error: e.message || 'That address could not be fetched' });
    }

    const type = MEDIA_TYPES[got.mime];
    if (!type) {
      return json(res, 415, {
        error: got.mime ? 'That address is a ' + got.mime + ', not a picture' : 'That is not a picture'
      });
    }
    if (!got.body.length) return json(res, 400, { error: 'That file was empty' });

    const id = randomBytes(16).toString('hex');
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(join(MEDIA_DIR, id + '.' + type.ext), got.body);
    db.mediaTeam[id] = team.id;
    await persist();

    return json(res, 200, {
      ok: true,
      media: {
        id, kind: type.kind, mime: got.mime,
        // The last part of the path makes a better label than the whole URL.
        name: decodeURIComponent(got.url.pathname.split('/').pop() || '').slice(0, 120)
              || got.url.hostname
      }
    });
  }

  if (path === '/api/media' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz maker can add media' });

    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const type = MEDIA_TYPES[mime];
    if (!type) return json(res, 415, { error: 'That kind of file is not supported' });

    const buf = await readRaw(req, MAX_MEDIA);
    if (!buf.length) return json(res, 400, { error: 'The file was empty' });

    const id = randomBytes(16).toString('hex');
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(join(MEDIA_DIR, id + '.' + type.ext), buf);
    // Remembered before it is handed back, so the team that uploaded it is the
    // only one that can attach it to a quiz or read it later.
    db.mediaTeam[id] = team.id;
    await persist();

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
    if (!isMaster()) return json(res, 403, { error: 'Only this week’s quiz maker can use the assistant' });
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
      /* Logged, not only returned. A failed quiz generation used to leave
         nothing behind at all, so "Request failed (502)" on the screen came
         with an empty journal and nothing to act on. `cause` is where Node
         puts the real reason when fetch itself fails. */
      console.error('Assistant failed:', (e && e.message) || e,
        e && e.cause ? '| cause: ' + ((e.cause && e.cause.message) || e.cause) : '');
      return json(res, 502, { error: (e && e.message) || 'The assistant did not answer' });
    }
  }

  if (path === '/api/roles' && req.method === 'POST') {
    if (!requireUser()) return;
    // Deciding who does what next week is an admin call, not the weekly quiz
    // master's - those stay separate on purpose.
    if (!isTeamMaster(me, team)) return json(res, 403, { error: 'Only the quiz master can change this' });
    const { quizMasterId, topicPickerId } = await readBody(req);
    if (!team.upcoming) return json(res, 400, { error: 'Nothing scheduled' });
    if (quizMasterId && !userById(team, quizMasterId)) return json(res, 400, { error: 'No such person' });
    if (topicPickerId && !userById(team, topicPickerId)) return json(res, 400, { error: 'No such person' });
    if (quizMasterId && isGuest(team, quizMasterId)) return json(res, 400, { error: 'A guest cannot be quiz maker' });
    if (topicPickerId && isGuest(team, topicPickerId)) return json(res, 400, { error: 'A guest cannot pick the topic' });
    if (quizMasterId && isRemoved(team, quizMasterId)) return json(res, 400, { error: 'That person has been removed' });
    if (topicPickerId && isRemoved(team, topicPickerId)) return json(res, 400, { error: 'That person has been removed' });
    if (quizMasterId) team.upcoming.quizMasterId = quizMasterId;
    if (topicPickerId) team.upcoming.topicPickerId = topicPickerId;
    team.upcoming.reason = { master: 'Set by hand', picker: 'Set by hand' };
    await persist(); broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* Running the game */

  if (path === '/api/live/start' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz maker can start it' });
    if (!quizReady(team.upcoming.quiz)) return json(res, 400, { error: 'The quiz is not finished yet' });
    team.live = {
      id: uid(), phase: 'lobby', index: 0,
      /* Whoever has the app open right now is in the room. Anyone else is
         added the moment they connect, further down in /api/events.

         Not the whole user list: that would have the lobby claiming a crowd
         before anyone had turned up, growing by one for every guest who ever
         played. And not an empty array either - the people already sitting
         there waiting for you to press Start are exactly the ones playing. */
      players: [...onlineIds(team.id)].filter((id) => !isRemoved(team, id)),
      // Anyone who has stepped out. Kept rather than just dropped from
      // players, or the next SSE reconnect would walk them straight back in.
      left: [],
      reveal: REVEAL_MODES.includes(team.revealMode) ? team.revealMode : 'end',
      answers: {}, tieGuesses: {}, startedAt: new Date().toISOString()
    };
    broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* When answers get shown: after every question, or all at the end. Settable
     before the game (remembered for next time) and during it, because which
     one suits only becomes obvious once the room is in front of you. */
  if (path === '/api/live/reveal' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!isMaster()) return json(res, 403, { error: 'Only the quiz maker decides this' });
    const { mode } = await readBody(req);
    if (!REVEAL_MODES.includes(mode)) return json(res, 400, { error: 'Unknown mode' });
    team.revealMode = mode;
    if (team.live) {
      team.live.reveal = mode;
      /* Switching mid-quiz can leave you on a step the new running order does
         not have - the gap only exists in 'end'. Nudge onto the nearest one
         that does rather than stranding the slides. */
      if (mode === 'each' && team.live.phase === 'gap') { team.live.phase = 'a'; team.live.index = 0; }
    }
    await persist(); broadcast(team);
    return json(res, 200, { ok: true, mode });
  }

  if ((path === '/api/live/advance' || path === '/api/live/back') && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz maker controls the slides' });
    if (!team.live) return json(res, 400, { error: 'Nothing running' });
    /* The coin decides which of those two writes next week's quiz, so it
       cannot be walked past unflipped. Back still works, and the flip needs
       no one's permission but the quiz maker's, so this strands nobody. */
    if (path.endsWith('advance') && team.live.phase === 'coin') {
      const pending = coinToss(team);
      if (pending && !pending.result) return json(res, 409, { error: 'Flip the coin first' });
    }
    (path.endsWith('advance') ? advance : back)(
      team.live, liveQuestionCount(team, team.live), !!coinToss(team));
    /* Two high-water marks, because stepping back is exactly the move that
       would otherwise clear them: how far the questions have got, and how far
       the answers have. Neither goes down. */
    if (team.live.phase === 'q') {
      team.live.asked = Math.max(team.live.asked ?? -1, team.live.index);
    }
    if (team.live.phase === 'a') {
      team.live.shown = Math.max(team.live.shown ?? -1, team.live.index);
    }
    broadcast(team);
    return json(res, 200, { ok: true, phase: team.live.phase, index: team.live.index });
  }

  if (path === '/api/live/answer' && req.method === 'POST') {
    if (!requireUser()) return;
    const { option } = await readBody(req);
    const live = team.live;
    if (!live || live.phase !== 'q') return json(res, 409, { error: 'Not taking answers now' });
    if (me === team.upcoming.quizMasterId) return json(res, 403, { error: 'You wrote this one' });
    /* Changing your mind while the question is up is the whole point. Once the
       quiz has left it, it is done - and the quiz maker stepping back does not
       undo that, or a question could be revised at leisure while it is re-read
       to the room.

       Two separate walls, because they close off different things. Once the
       answer has been on the board nobody may touch that question at all. But
       merely having moved on only locks the people who already answered:
       somebody who missed it entirely can still catch up, which is usually why
       the quiz maker went back. */
    if (live.index <= (live.shown ?? -1)) {
      return json(res, 409, { error: 'That answer has already been shown' });
    }
    if (live.index < (live.asked ?? -1) && (live.answers[me] || {})[live.index] !== undefined) {
      return json(res, 409, { error: 'The quiz has moved on from that one' });
    }
    // Left the quiz. Nothing they send counts until they rejoin, or a phone
    // left on a table goes on answering for someone who has gone home.
    if ((live.left || []).includes(me)) return json(res, 409, { error: 'You have left this quiz' });
    joinLive(live, me);
    live.answers[me] = live.answers[me] || {};
    live.answers[me][live.index] = Number(option);
    broadcast(team);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/tiebreak' && req.method === 'POST') {
    if (!requireUser()) return;
    const { value } = await readBody(req);
    const live = team.live;
    if (!live || live.phase !== 'tb') return json(res, 409, { error: 'Not taking guesses now' });
    if (me === team.upcoming.quizMasterId) return json(res, 403, { error: 'You wrote this one' });
    /* One guess each. Unlike the questions, where changing your mind before the
       next slide is harmless, the tiebreaker decides a tie - letting someone
       resubmit after seeing the counter climb would be a second bite. The
       button locks on the phone too; this is what makes that mean anything. */
    if (live.tieGuesses[me] !== undefined) {
      return json(res, 409, { error: 'You have already guessed' });
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return json(res, 400, { error: 'That is not a number' });
    // Left the quiz. Nothing they send counts until they rejoin, or a phone
    // left on a table goes on answering for someone who has gone home.
    if ((live.left || []).includes(me)) return json(res, 409, { error: 'You have left this quiz' });
    joinLive(live, me);
    live.tieGuesses[me] = n;
    broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* One of the two calls heads or tails. Theirs to call and nobody else's -
     the quiz maker holds every other control in the game, but not this one. */
  if (path === '/api/live/call' && req.method === 'POST') {
    if (!requireUser()) return;
    const live = team.live;
    if (!live || live.phase !== 'coin') return json(res, 409, { error: 'Not calling it now' });
    const toss = coinToss(team);
    if (!toss) return json(res, 409, { error: 'There is nothing to call' });
    if (toss.result) return json(res, 409, { error: 'It has already been flipped' });
    if (!toss.players.some((p) => p.userId === me)) {
      return json(res, 403, { error: 'This one is not yours to call' });
    }
    const { side } = await readBody(req);
    if (!SIDES.includes(side)) return json(res, 400, { error: 'Heads or tails' });
    // One side each, and whoever called first keeps it.
    const taken = Object.keys(live.coin.calls)
      .some((id) => id !== me && live.coin.calls[id] === side);
    if (taken) return json(res, 409, { error: 'They called that one' });
    live.coin.calls[me] = side;
    broadcast(team);
    return json(res, 200, { ok: true, side });
  }

  /* The quiz maker flips it, in the room, in front of everyone. */
  if (path === '/api/live/flip' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz maker flips it' });
    const live = team.live;
    if (!live || live.phase !== 'coin') return json(res, 409, { error: 'Nothing to flip' });
    const toss = coinToss(team);
    if (!toss) return json(res, 409, { error: 'Nothing to flip' });
    // Landing twice would be a re-roll, so a second press is simply the first.
    if (toss.result) return json(res, 200, { ok: true, result: toss.result });

    /* Anyone who never called takes the side left over. A coin still lands if
       one of them has wandered off, and the call that was made still stands. */
    const spare = SIDES.filter((side) => !Object.values(live.coin.calls).includes(side));
    toss.players.forEach((p) => {
      if (!live.coin.calls[p.userId]) live.coin.calls[p.userId] = spare.pop() || SIDES[0];
    });
    live.coin.result = SIDES[Math.random() < 0.5 ? 0 : 1];
    broadcast(team);
    return json(res, 200, { ok: true, result: live.coin.result });
  }

  if (path === '/api/live/roles' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz maker can change this' });
    const { quizMasterId, topicPickerId } = await readBody(req);
    if (!team.live) return json(res, 400, { error: 'Nothing running' });
    if (quizMasterId && isGuest(team, quizMasterId)) return json(res, 400, { error: 'A guest cannot be quiz maker' });
    if (topicPickerId && isGuest(team, topicPickerId)) return json(res, 400, { error: 'A guest cannot pick the topic' });
    team.live.roleOverride = {
      quizMasterId, topicPickerId,
      reason: { master: 'Chosen by the quiz maker', picker: 'Chosen by the quiz maker' }
    };
    broadcast(team);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/finish' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz maker can finish it' });
    const live = team.live;
    if (!live) return json(res, 400, { error: 'Nothing running' });
    if (live.committed) return json(res, 200, { ok: true });

    const rows = rankLive(team);
    const toss = coinToss(team);           // before live.final, which caches it
    const roles = live.roleOverride || deriveRoles(team, rows);
    const u = team.upcoming;

    team.history.push({
      id: live.id,
      // The day it was played, which is not the day it was booked for if it
      // slipped - or if it was brought forward. Said plainly rather than
      // derived from the booking, which is what let a quiz played in August
      // file itself under September.
      date: todayISO(),
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
      coin: toss,
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
    team.upcoming = {
      id: uid(), date: nextFriday(after),
      quizMasterId: roles.quizMasterId, topicPickerId: roles.topicPickerId,
      reason: roles.reason, topic: '', quiz: null
    };
    await persist(); broadcast(team);
    return json(res, 200, { ok: true });
  }

  /* Stepping out of a running quiz. Not the same as signing out, and not the
     quiz maker's business either - they have Stop, which ends it for the room.
     Answers already given are kept, so coming back picks up where you were. */
  if (path === '/api/live/leave' && req.method === 'POST') {
    if (!requireUser()) return;
    const live = team.live;
    if (!live) return json(res, 200, { ok: true });
    if (me === (live.final ? live.final.quizMasterId : team.upcoming.quizMasterId)) {
      return json(res, 403, { error: 'You are running it. Use Stop to end it for everyone.' });
    }
    live.left = live.left || [];
    if (!live.left.includes(me)) live.left.push(me);
    live.players = live.players.filter((p) => p !== me);
    broadcast(team);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/rejoin' && req.method === 'POST') {
    if (!requireUser()) return;
    const live = team.live;
    if (!live) return json(res, 400, { error: 'Nothing running' });
    live.left = (live.left || []).filter((p) => p !== me);
    joinLive(live, me);
    broadcast(team);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/live/stop' && req.method === 'POST') {
    if (!requireUser()) return;
    if (!runsLive()) return json(res, 403, { error: 'Only the quiz maker can stop it' });
    team.live = null;
    broadcast(team);
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
     path cannot reach anything outside MEDIA_DIR.

     This used to be served to anyone who had the URL, signed in or not. A
     picture can give away an answer, and under teams it would hand one team's
     files to another, so it now needs a session on the owning team. Browsers
     send the cookie with same-origin <img>/<audio>, so nothing has to change
     in the markup. */
  if (path.startsWith('/media/')) {
    const name = path.slice('/media/'.length);
    const m = /^([a-f0-9]{16,64})\.([a-z0-9]{2,5})$/.exec(name);
    if (!m || !MEDIA_MIME[m[2]]) return send(res, 404, 'Not found');

    const session = whoami(req);
    const team = session ? teamById(session.teamId) : null;
    // 404 rather than 403: whether a file exists is not their business either.
    if (!team || !ownsMedia(team, m[1])) return send(res, 404, 'Not found');

    const file = join(MEDIA_DIR, m[1] + '.' + m[2]);
    if (!existsSync(file)) return send(res, 404, 'Not found');
    try {
      const buf = await readFile(file);
      const headers = {
        'content-type': MEDIA_MIME[m[2]],
        /* Private, not public: it is now per-session, so a shared cache must
           never hand one team's file to the next person through it. */
        'cache-control': 'private, max-age=31536000, immutable',
        /* Say that byte ranges are understood. A <video> or <audio> element
           asks for one, and a player that is told nothing has to fetch the
           whole file before it will let anybody scrub - which for a clip of
           any size means the scrubber on the stage does nothing at all. */
        'accept-ranges': 'bytes'
      };

      /* One range, which is all a media element ever asks for. Anything odder
           - several ranges, a suffix range - is answered in full, which is
         always allowed and is what happened before this existed. */
      const asked = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
      if (asked && (asked[1] || asked[2])) {
        let start, end;
        if (asked[1] === '') {
          // bytes=-500 means the last 500, not the first - the one form of
          // this header where the number is a length rather than a position.
          start = Math.max(0, buf.length - Number(asked[2]));
          end = buf.length - 1;
        } else {
          start = Number(asked[1]);
          end = asked[2] === '' ? buf.length - 1 : Number(asked[2]);
        }
        end = Math.min(end, buf.length - 1);

        if (start > end || start >= buf.length) {
          res.writeHead(416, { 'content-range': 'bytes */' + buf.length });
          return res.end();
        }
        const slice = buf.subarray(start, end + 1);
        res.writeHead(206, {
          ...headers,
          'content-length': slice.length,
          'content-range': 'bytes ' + start + '-' + end + '/' + buf.length
        });
        return res.end(slice);
      }

      res.writeHead(200, { ...headers, 'content-length': buf.length });
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
  for (const t of teamList()) {
    console.log('    Team:   ' + t.name + '  ·  '
      + (inviteCode(t) ? 'code ' + inviteCode(t) : 'open (no code set)'));
  }
  console.log('    Stop with Ctrl+C\n');
});
