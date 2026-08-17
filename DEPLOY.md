# Deploying Friday Quiz

Push to GitHub, connect the repo, done — the same workflow as a static site.
No ports to open, no firewall, no server to patch, no certificate to set up.

Runs the same `server.mjs` you run locally. No rewrite, no build step, no
dependencies.

---

## Why a container and not a static host

Your other site is static files plus serverless functions, which is why it was
so easy. This one is a real server: it holds live game state in memory and
keeps a push connection open to every phone in the room. It needs

- **one always-on process** (not serverless, and never two copies), and
- **a disk that survives redeploys** for accounts, history and uploads.

The `Dockerfile` in this repo is nine lines and needs no attention.

---

## Deploy on Northflank (free)

Free plan: 2 services, 1 vCPU, 1 GB RAM, a persistent volume, GitHub
integration, and **no sleeping** — so the first person to open the link on a
Friday doesn't wait for a cold start.

### 1. Push this repo to GitHub

`.env` is gitignored, so your keys stay out of it.

### 2. Create the service

New service → **Deployment** → **Build from Git**, pick the repo.
It finds the `Dockerfile` on its own. Port **8080** is already exposed, and
you get an `https://…` domain automatically.

### 3. Add the volume — do this before you share the link

Add a persistent volume mounted at **`/data`**. 1 GB is plenty to start.

> **This is the one step that actually matters.** `QUIZ_DATA_DIR=/data` is
> already set in the `Dockerfile`, so with the volume mounted your accounts,
> history and uploaded media survive every redeploy. Without it they are wiped
> each time you push.

### 4. Set two environment variables

| Variable | Value |
|---|---|
| `DEEPSEEK_API_KEY` | your key, for the Quizzy assistant |
| `QUIZ_INVITE_CODE` | any phrase only your team knows |

`QUIZ_INVITE_CODE` is what stops a stranger who finds the URL from creating an
account — and, since nobody has claimed admin on a fresh install, from taking
admin and resetting everyone's passwords. **Set it before the link is
reachable.** People who already signed up are never asked for it.

### 5. Sign up first, then claim admin

Open the URL, create your account, go to **Team → Become admin**. Admin is
first-come-first-served; the invite code is the lock, this is the bolt.

Then share the URL and the invite code with the team.

### After that

`git push` redeploys. That's the whole workflow.

---

## Watch the volume size

Uploaded pictures, audio and video go on the volume and are **never deleted** —
past quizzes in the history still point at them. A 48 MB video round adds up
fast against a 1 GB volume. If it fills, raise the volume size or delete old
files under `/data/media`.

## Back it up

Everything that matters is under `/data`. There is no database to dump. Copy it
somewhere occasionally — Northflank has a shell into the running service.

---

## Other hosts

The same `Dockerfile` and the same two settings work anywhere that runs a
container with a volume — Railway, Render, Fly.io, a $4/mo VPS. Check two
things before committing:

- **A persistent volume**, not ephemeral disk. Render's *free* tier cannot
  attach one, so data is lost on every redeploy.
- **No sleeping.** A host that idles out will drop the live game and log
  everyone out mid-quiz.

### On a plain VM instead

If you would rather run it on a Linux box you control, `deploy/` has a systemd
unit and a Caddyfile for automatic HTTPS. That path is more work — you open
firewall ports and patch the OS yourself — but it avoids depending on a
platform. Set `QUIZ_BIND=127.0.0.1` there so the plain-HTTP port isn't exposed;
Caddy handles TLS in front.

---

## What still isn't hardened

Be clear-eyed about what you're putting on the internet:

- **No rate limiting on login.** Someone who knows a teammate's name can
  brute-force their password as fast as the server answers. Passwords are
  scrypt-hashed, so a leaked data file isn't catastrophic, but the endpoint
  itself is unprotected.
- **Any admin can reset any password.** That's the documented trade for having
  no email on file; on a public URL it means the admin account is the one worth
  giving a real password.
- **The invite code is shared, not per-person.** Once it's out, it's out —
  change it by editing the variable and redeploying.
