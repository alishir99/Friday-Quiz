# Friday Quiz

A small, plain Kahoot for a weekly team quiz.

The quiz master puts the questions on the big screen. Everyone else answers on
their own phone. Scores are worked out automatically, and the app decides who
runs it next week:

- **Last place** writes next week's quiz.
- **Second from last** chooses the topic.
- **The quiz master is not scored**, because they wrote it.
- Ties are settled by whoever's tiebreaker number was closest.

No build step, no `npm install`, no framework, no dependencies.

---

## Running it

```bash
node server.mjs
```

It prints two addresses. Open the first on the machine plugged into the
projector; give the second to everyone else for their phones. Same link for
everybody, and there are no room codes to type.

```bash
node server.mjs 3000
```

Data is kept in `data/friday-quiz.json`. To have it live in a OneDrive or
SharePoint synced folder so it is backed up:

```bash
QUIZ_DATA_DIR="C:/Users/you/OneDrive - Company/Friday Quiz" node server.mjs
```

Add the link to your SharePoint team page as a Link web part and that is the
whole integration. No Azure app registration, no IT ticket.

Set `ANTHROPIC_API_KEY` to turn on the quiz-writing assistant (below):

```bash
ANTHROPIC_API_KEY="sk-ant-..." node server.mjs
```

## Quiz assistant

An *✨ Ask the assistant* button sits in the quiz editor, next to the save
status — only the quiz master sees it, same as the editor itself. It's a
small chat: ask for question ideas and it writes back, backed by Claude with
a live web search. It always fact-checks before answering rather than
trusting its own memory, and every factual claim comes with a source link
underneath — read it before you trust it, the same as you would a
teammate's guess.

It needs `ANTHROPIC_API_KEY` set when the server starts (see above). Without
it, the button is still there but sending a message shows an error saying
so. Nothing about it is stored: the conversation lives in the browser tab
only and is gone on refresh — it's a drafting aid, not part of the quiz
record.

---

## Accounts

Sign-in is name and password. First time creates the account with whatever
password you type; every time after that it has to match. Nothing is
collected beyond the name and password — no email, no other personal data.
The session is a long-lived (180-day) HttpOnly cookie, so a phone or laptop
that has signed in once stays signed in.

There is no email on file, so "forgot password" doesn't work by email link.
Instead, the admin resets it from the Team page: that generates a temporary
password to hand over directly (in person, on Slack), and the person changes
it to something of their own from the account menu after signing in. The name
is the account, so two teammates can't share one: whoever sets a password for
"John" first owns that name, and a second John has to sign in under something
distinguishable instead (e.g. "John S."). It runs over plain HTTP on your
internal network for a trusted team; it is not built to resist a determined
attacker.

Sign-ins are held in memory, so everyone signs in again after a server restart
(same name and password, not a fresh account). Accounts and history are on
disk and survive.

The team page shows who is currently online (a green dot, live via the same
push connection the game uses) so the quiz master can see who's actually
around before starting, since not everyone shows up every week. It also has a
QR code, so people in the room can scan and sign up on their own phone
instead of typing the address in.

## Admin

A fixed person, separate from the weekly quiz master/topic picker rotation.
Nobody is admin by default — whoever gets to the Team page first and presses
*Become admin* is it, and after that only they can hand it to someone else
(also from the Team page). The admin has three jobs: resetting a forgotten
password, editing the Rules page (nobody else can), and hand-picking next
week's quiz master and topic picker from the home screen if the algorithm's
choice needs overriding. Everything about running an actual Friday — writing
the quiz, presenting it, controlling the slides — stays with that week's quiz
master, same as always. The two roles are kept deliberately separate: the
quiz master is whoever the rotation lands on this week, the admin is a fixed
person who doesn't change week to week.

---

## A Friday, start to finish

1. **Topic picker** sets the topic on the home screen. The quiz master can also
   type it in, since the topic usually arrives as a Teams message rather than
   through the app. Those two are the only people who see it: everyone else's
   home screen says a topic has been chosen and leaves it at that.
2. **Quiz master** writes ten questions, each with two to six options and one marked
   correct, plus a tiebreaker whose answer is a number. A picture, sound clip or
   video can be dropped straight onto the question box, or picked from a file
   dialog. It saves as they type. Nobody else can open the editor.
3. **Quiz master presses Start.** Everyone else's screen switches to the game on
   its own; there is nothing for them to find or join. The lobby that shows up
   first has a QR code, for anyone still fishing their phone out. The topic
   stays hidden from everyone but the quiz master and topic picker right up
   until this moment — pressing Start is what reveals it, on the lobby screen.
4. **Ten questions.** Each one goes up on the big screen; players tap an answer
   on their phone and can change it until the next question. The big screen
   shows how many have answered, not what they picked.
5. **Tiebreaker.** Everyone types a number.
6. **The answers.** The same ten slides again, this time with the right answer
   shown. Each player also sees whether they got it. The tiebreaker slide lists
   everyone's number, closest first, so the room can see who was nearest.
7. **Scores**, worked out automatically.
8. **Next week's quiz master and topic picker**, with the reason. The quiz
   master presses *Save and finish* and it rolls over to next Friday.

The quiz master can swap the two names before saving if someone is away.

## Keys for the quiz master

`→` / `Space` next · `←` back · `F` full screen

Every one of these is also a button on screen.

---

## Files

```
index.html      markup and script tags
styles.css      the whole visual language
js/qrcode.js    vendored QR encoder (MIT, kazuhikoarase/qrcode-generator)
js/store.js     shared helpers, the all-time table
js/ui.js        DOM helpers, dialogs, toasts
js/net.js       accounts, actions, the live feed
js/screens.js   sign in, home, team, editor, history, rules
js/live.js      the running quiz: big screen and phone
js/app.js       boot, routing, keyboard
server.mjs      accounts, game state, scoring, real-time push, quiz assistant
```

## Notes

- **Correct answers are never sent to a player's browser** until the reveal.
  The server strips them out, so devtools shows nothing useful mid-question.
- **The topic is stripped the same way.** Only the topic picker and the quiz
  master are sent the words; everyone else gets a flag saying one is set. Once
  the game starts it is on the projector anyway, so it goes out to everybody.
- **Files can be dropped anywhere on a question**, open or closed, and onto the
  tiebreaker. The question box itself is the target, so a file can go straight
  onto the words it belongs with; a drop on a closed question opens it first.
  Anything that is not a supported picture, sound or video is refused before the
  upload starts, as is anything over 48 MB.
- **Tiebreaker guesses are held back like the answers are**, and go out to
  everyone at once on the reveal slide. Whoever was closest is marked, and
  anyone who never typed a number is listed too.
- **Light theme by default**, whatever the machine prefers, so the projector
  looks the same every week. *Automatic* and *Dark* are in the account menu and
  are remembered per browser.
- **Pictures show on phones; sound and video stay on the big screen.** Players
  need to see an image to answer, but ten handsets playing the same clip a
  second apart would be unusable, so those slides just say to watch the screen.
- **Media** is uploaded by the quiz master only, capped at 48 MB per file, and
  limited to common image, audio and video types. Files are stored under
  `data/media` with a server generated name, never the uploaded one. They are
  kept forever, because past quizzes in the history still point at them.
- **Live updates** use server-sent events, falling back to polling if those are
  blocked. A dropped connection shows a "Reconnecting…" bar and recovers itself.
- **A restart cancels a game in progress** but never loses accounts or history.
  Start it again from the home screen.
- Answers are per-account, so nobody can answer twice or answer for someone else.
