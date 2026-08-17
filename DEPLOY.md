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

See [the Oracle Cloud walkthrough](#free-forever-on-an-oracle-cloud-vm) below —
free forever, and it runs this same code unchanged.

---

## Free forever, on an Oracle Cloud VM

More setup than a platform, but no monthly bill and nothing to rewrite. The
commands below were run end to end on a clean Ubuntu 24.04 image.

### 1. Make the VM

Oracle Cloud console → **Compute → Instances → Create instance**.

- **Image:** Ubuntu 24.04
- **Shape:** `VM.Standard.A1.Flex` (Ampere ARM). The Always Free allowance is
  2 OCPU / 12 GB as of June 2026. If your region is out of ARM capacity, the
  `VM.Standard.E2.1.Micro` x86 shape is also Always Free and is ample here.
- Add your SSH public key.

Always Free shapes don't expire the way trial credits do.

### 2. Open ports 80 and 443 — in *both* places

This is the step that costs people an hour. Oracle blocks traffic at two
independent layers and you have to open both.

**a) The cloud firewall.** Instance → *Subnet* → *Security List* → add ingress
rules, source `0.0.0.0/0`, for TCP **80** and **443**.

**b) The VM's own firewall.** Oracle's Ubuntu images ship iptables rules that
drop everything:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 3. Install Node and Caddy

```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs caddy git
node --version   # v22 or newer
```

### 4. Put the app on the box

Order matters here: **do not** use `useradd --create-home`. It fills the
directory with shell profile files, and `git clone` then refuses to write into
a non-empty directory.

```bash
sudo useradd --system --home-dir /opt/friday-quiz --shell /usr/sbin/nologin quiz
sudo git clone https://github.com/alishir99/Friday-Quiz.git /opt/friday-quiz
sudo chown -R quiz:quiz /opt/friday-quiz
```

### 5. Secrets

```bash
sudo -u quiz tee /opt/friday-quiz/.env >/dev/null <<'EOF'
DEEPSEEK_API_KEY=sk-your-new-key
QUIZ_INVITE_CODE=pick-something-only-your-team-knows
EOF
sudo chmod 600 /opt/friday-quiz/.env
```

The app reads this file itself on startup — no shell export needed.

### 6. Run it as a service

```bash
sudo cp /opt/friday-quiz/deploy/friday-quiz.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now friday-quiz
curl -s localhost:8080/api/state    # {"anonymous":true,...}
```

`QUIZ_BIND=127.0.0.1` is set in the unit, so the plain-HTTP port is reachable
only from the VM itself. Caddy sits in front of it.

### 7. HTTPS

Point an `A` record at the VM's public IP, then:

```bash
sudo cp /opt/friday-quiz/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/quiz.example.com/quiz.yourdomain.com/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The certificate is issued and renewed automatically.

### Running it

```bash
cd /opt/friday-quiz && sudo -u quiz git pull && sudo systemctl restart friday-quiz
journalctl -u friday-quiz -f          # logs
sudo tar czf ~/quiz-$(date +%F).tgz -C /opt/friday-quiz data   # backup
```

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
