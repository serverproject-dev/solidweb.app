# solidweb.app setup v7

# solidweb.app — Full Server Setup Guide (v7)

###### tags: `melvin` `matthias` `solid` `jss` `debian` `trixie` `pm2` `nginx` `letsencrypt`

**Server:** `92.205.60.157` · **OS:** Debian 13 Trixie (stable, released 2025-08-09, latest point release 13.4 as of 2026-03-14)
**Domain:** `solidweb.app`
**Stack:** Debian 13 Trixie · nvm · Node.js 24.11.0 · PM2 · JavaScript Solid Server (JSS) · Nginx 1.26.x · Let's Encrypt (wildcard) · Certbot 4.0 · Netdata · Uptime Kuma

> **Credits:** The JavaScript Solid Server (JSS) is created by
> [Melvin Carvalho](https://melvin.me/) — web pioneer, mathematician, Solid enthusiast,
> and long-time contributor to the Solid ecosystem and decentralised web.

---

## Table of Contents

[TOC]

---

## 0. Crosscheck Notes (v5 → v6)

This version reflects the **only** change: from Debian 12 Bookworm to **Debian 13 Trixie**.
Every component was re-verified against Trixie-specific sources.

| Component | Bookworm (v5) | Trixie (v6) | Impact |
|---|---|---|---|
| OS | Debian 12 Bookworm (oldstable) | **Debian 13 Trixie (stable, 13.4)** | Name/version strings |
| Nginx (apt) | 1.22.1 | **1.26.3** | `apt install nginx` unchanged |
| Certbot (apt) | 2.1 | **4.0** | commands unchanged |
| `python3-certbot-dns-cloudflare` | 2.x | **4.0.0-2** (Trixie repo) | `apt install` unchanged |
| gcc (system) | 12.2 | **14.2** | nvm builds fine |
| Node.js (system apt) | 18.x | 20.x (EOL April 2026) | irrelevant — we use nvm |
| nvm | v0.40.4 | **v0.40.4** | unchanged |
| Node.js via nvm | 24.11.0 | **24.11.0** | unchanged |
| Netdata (Debian apt) | in Bookworm repo | **removed from Trixie** ⚠️ | §12 updated — kickstart.sh only |
| UFW | `apt install ufw` | **`apt install ufw`** | unchanged |
| PM2 / JSS / Uptime Kuma | unchanged | **unchanged** | unchanged |

> **Critical Trixie finding — Netdata:** Debian removed Netdata from its Trixie
> repositories because the project's web UI became closed-source. `apt install netdata`
> fails with "package not found" on Trixie. The correct install path is Netdata's own
> `kickstart.sh`, which installs from `repository.netdata.cloud` and supports Trixie.
> Section 12 is updated accordingly.

---

## 1. Architecture Overview

```
Internet
│
▼
92.205.60.157 :80 / :443
│
▼
┌──────────────────────────────────────────────────────────────────┐
│  Nginx 1.26.x (reverse proxy + TLS termination, wildcard cert)  │
│                                                                  │
│  solidweb.app            → JSS :3000  (root / login / IDP)      │
│  *.solidweb.app          → JSS :3000  (per-user pods)           │
│  status.solidweb.app     → Uptime Kuma :3001                    │
│  monitor.solidweb.app    → Netdata :19999                       │
└──────────────────────────────────────────────────────────────────┘
         ↑                        ↑
   PM2 (user: jss)          PM2 (user: kuma)
   manages JSS               manages Uptime Kuma
   pm2-jss.service           pm2-kuma.service
   (auto-generated            (auto-generated
    by PM2 startup)            by PM2 startup)
```

**Process management strategy:**
- **PM2** manages JSS and Uptime Kuma — one PM2 daemon per service user (`jss`, `kuma`).
- PM2's `startup` command auto-generates a systemd unit for each user.
- **Netdata** uses its own native systemd service (not a Node.js process, not PM2).
- **Nginx** uses its own native systemd service.
- All Node.js services bind to `127.0.0.1` only; Nginx is the sole public gateway.
- **Registration is open** — anyone can create a pod at `<username>.solidweb.app`.
- **Access control model: WAC** (Web Access Control, `.acl` files) — the JSS default.

> **Why one PM2 per user and not a shared root PM2?** Running PM2 as root is a security
> anti-pattern. Separate per-user PM2 daemons isolate each service's process tree, logs
> (`~/.pm2/logs`), and dump file. Each generates its own systemd unit independently.

---

## 2. DNS Setup

| Hostname          | Type | Value           | Purpose                      |
|-------------------|------|-----------------|------------------------------|
| `solidweb.app`    | A    | `92.205.60.157` | Root domain / Solid IDP      |
| `*.solidweb.app`  | A    | `92.205.60.157` | All user pods + subservices  |

> One wildcard A record covers everything. No individual subdomain records needed.

Verify propagation before step 10:

```bash
dig alice.solidweb.app +short      # → 92.205.60.157
dig status.solidweb.app +short     # → 92.205.60.157
dig monitor.solidweb.app +short    # → 92.205.60.157
```

---

## 3. Server Preparation

```bash
apt update && apt upgrade -y

apt install -y \
  curl wget git \
  build-essential \
  ufw \
  nginx \
  certbot \
  apache2-utils

hostnamectl set-hostname solidweb
```

> **Trixie package versions confirmed:**
> - `nginx` → **1.26.3** · `certbot` → **4.0** · `gcc` → **14.2**
> - `ufw` is not pre-installed on any Debian release — `apt install ufw` is always needed.
> - `python3-certbot-nginx` is intentionally **not** installed (wildcard = DNS-01 only).
> - `apache2-utils` provides `htpasswd` for Netdata basic auth.

---

## 4. Node.js via nvm

### 4.1 Create dedicated service users

```bash
useradd --system --create-home --shell /bin/bash --home-dir /home/jss  jss
useradd --system --create-home --shell /bin/bash --home-dir /home/kuma kuma
```

### 4.2 Install nvm for both users

```bash
su - jss  -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash'
su - kuma -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash'
```

### 4.3 Install Node.js 24.11.0

```bash
su - jss  -c 'source /home/jss/.nvm/nvm.sh  && nvm install 24.11.0 && nvm alias default 24.11.0'
su - kuma -c 'source /home/kuma/.nvm/nvm.sh && nvm install 24.11.0 && nvm alias default 24.11.0'
```

Verify:

```bash
su - jss  -c 'source /home/jss/.nvm/nvm.sh  && node --version && npm --version'
su - kuma -c 'source /home/kuma/.nvm/nvm.sh && node --version && npm --version'
# Expected: v24.11.0
```

> JSS requires Node.js 18+ (official docs). 24.11.0 is fully compatible.
> Trixie ships Node.js 20 via `apt` — irrelevant since we use nvm exclusively.

---

## 5. PM2 Installation

### 5.1 Install PM2 for both users

```bash
su - jss  -c 'source /home/jss/.nvm/nvm.sh  && npm install -g pm2'
su - kuma -c 'source /home/kuma/.nvm/nvm.sh && npm install -g pm2'
```

> Never `sudo npm install -g pm2` — installs into system npm, causing PATH failures at boot.

Verify:

```bash
su - jss  -c 'source /home/jss/.nvm/nvm.sh  && pm2 --version'
su - kuma -c 'source /home/kuma/.nvm/nvm.sh && pm2 --version'
```

### 5.2 Install pm2-logrotate

```bash
su - jss  -c 'source /home/jss/.nvm/nvm.sh  && pm2 install pm2-logrotate'
su - kuma -c 'source /home/kuma/.nvm/nvm.sh && pm2 install pm2-logrotate'
```

---

## 6. JavaScript Solid Server (JSS)

### 6.1 Install

```bash
su - jss -c 'source /home/jss/.nvm/nvm.sh && npm install -g javascript-solid-server'
```

Verify:

```bash
su - jss -c 'source /home/jss/.nvm/nvm.sh && jss --help'
```

### 6.2 Create data directory

```bash
mkdir -p /var/lib/jss/data
chown -R jss:jss /var/lib/jss
```

### 6.3 Run `jss init` (interactive sanity check)

```bash
sudo -u jss bash -c '
  source /home/jss/.nvm/nvm.sh
  cd /var/lib/jss
  jss init
'
# Walk the prompts to confirm the binary works. Output not used directly.
```

### 6.4 Production config file

```bash
mkdir -p /etc/jss
```

Create `/etc/jss/config.json`:

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "root": "/var/lib/jss/data",
  "subdomains": true,
  "baseDomain": "solidweb.app",
  "conneg": true,
  "notifications": true,
  "idp": true,
  "idpIssuer": "https://solidweb.app",
  "mashlibCdn": true,
  "defaultQuota": "1GB"
}
```

**Config key reference** (crosschecked against official JSS docs):

| Key | Ref | Value | Notes |
|---|---|---|---|
| `port` | ✅ | `3000` | JSS default; Nginx proxies externally |
| `host` | ✅ | `"127.0.0.1"` | Loopback only — override from `0.0.0.0` |
| `root` | ✅ | `/var/lib/jss/data` | Persistent data dir |
| `subdomains` | ✅ | `true` | Pod at `alice.solidweb.app`, not `/alice/` |
| `baseDomain` | ✅ | `"solidweb.app"` | Required for subdomain URI construction |
| `conneg` | ✅ | `true` | Turtle ↔ JSON-LD content negotiation |
| `notifications` | ✅ | `true` | WebSocket updates (solid-0.1 protocol) |
| `idp` | ✅ | `true` | Built-in Identity Provider |
| `idpIssuer` | ⚠️ gh-pages only | `"https://solidweb.app"` | Not in canonical config table; in extended docs. No trailing slash |
| `mashlibCdn` | ✅ | `true` | SolidOS browser from unpkg CDN |
| `defaultQuota` | ✅ | `"1GB"` | Per-pod storage limit |

> **Open registration:** `inviteOnly` key is absent → registration is fully open.

```bash
chown -R jss:jss /etc/jss
```

### 6.5 Sanity test before PM2

```bash
sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && jss start --config /etc/jss/config.json'
# Look for: "Server listening on 127.0.0.1:3000" — then Ctrl+C
```
### sub 6.6 Start JSS under PM2 (as jss user)
```
sudo -u jss bash -c '
  source /home/jss/.nvm/nvm.sh
  pm2 start /etc/jss/ecosystem.config.js --env production
'
```
### sub 6.7 Verify it shows "online" before saving
`sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && pm2 status'`

### sub 6.8 Save the process list so it survives reboots
`sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && pm2 save`

### sub 6.9 restart
```
systemctl restart pm2-jss.service
systemctl status pm2-jss.service
```
---

## 7. Uptime Kuma

> **Important:** There is no `uptime-kuma-server` binary and `npm install -g uptime-kuma`
> installs an abandoned npm stub (v2.0.0-dev.0, unpublished 2 years ago). The only correct
> install method per the [official wiki](https://github.com/louislam/uptime-kuma/wiki/🔧-How-to-Install)
> is `git clone` + `npm run setup`. PM2 then points directly at `server/server.js`
> inside the cloned repository.

### 7.1 Clone and set up the repository

```bash
# All operations as the kuma user, into /var/lib/kuma (the app + data live here)
sudo -u kuma bash -c '
  source /home/kuma/.nvm/nvm.sh
  git clone https://github.com/louislam/uptime-kuma.git /var/lib/kuma
  cd /var/lib/kuma
  npm run setup
'
```

> `npm run setup` checks out the latest stable release tag, installs production
> dependencies, and downloads the prebuilt frontend (`dist/`). It takes a minute or two.

### 7.2 Configure via .env file

Uptime Kuma reads configuration from a `.env` file in the repo root. Create it now:

```bash
cat > /var/lib/kuma/.env <<'EOF'
UPTIME_KUMA_HOST=127.0.0.1
UPTIME_KUMA_PORT=3001
DATA_DIR=/var/lib/kuma/data
EOF
chown kuma:kuma /var/lib/kuma/.env
```

> `UPTIME_KUMA_HOST=127.0.0.1` binds to loopback only — Nginx proxies public traffic.
> `DATA_DIR` stores the SQLite database and config separately from the app code,
> which makes updates cleaner (the `data/` dir survives a `git checkout` to a new release).

### 7.3 Sanity test before PM2

```bash
sudo -u kuma bash -c '
  source /home/kuma/.nvm/nvm.sh
  cd /var/lib/kuma
  node server/server.js
'
# Look for: "[SERVER] INFO: Listening on 127.0.0.1:3001"
# Ctrl+C
```

> Uptime Kuma has **no default password**. Admin account is created on first browser visit.

---

## 8. PM2 Ecosystem Files & Boot Hook

Read fully before executing. Order matters.

### 8.1 Ecosystem file for JSS

Create `/etc/jss/ecosystem.config.js`:

```js
module.exports = {
  apps: [
    {
      name: 'jss',
      // Full absolute path — PM2 at boot does not source .bashrc and cannot
      // resolve nvm shims.
      script: '/home/jss/.nvm/versions/node/v24.11.0/bin/jss',
      args: 'start --config /etc/jss/config.json',
      cwd: '/var/lib/jss',

      exec_mode: 'fork',   // correct for JSS — cluster mode is for stateless HTTP apps
      instances: 1,

      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 4000,
      max_memory_restart: '512M',

      out_file:   '/home/jss/.pm2/logs/jss-out.log',
      error_file: '/home/jss/.pm2/logs/jss-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env_production: {
        NODE_ENV: 'production',
        PATH: '/home/jss/.nvm/versions/node/v24.11.0/bin:' + process.env.PATH,
      },
    },
  ],
};
```

```bash
chown jss:jss /etc/jss/ecosystem.config.js
```

### 8.2 Ecosystem file for Uptime Kuma

Create `/home/kuma/ecosystem.config.js`:

```js
module.exports = {
  apps: [
    {
      name: 'uptime-kuma',

      // Entry point is server/server.js inside the cloned repo.
      // There is no global binary — uptime-kuma is not installed via npm -g.
      script: 'server/server.js',
      cwd: '/var/lib/kuma',

      // .env in the cwd is loaded automatically by Uptime Kuma
      // (UPTIME_KUMA_HOST, UPTIME_KUMA_PORT, DATA_DIR are set there)

      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 4000,
      max_memory_restart: '256M',

      out_file:   '/home/kuma/.pm2/logs/uptime-kuma-out.log',
      error_file: '/home/kuma/.pm2/logs/uptime-kuma-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env_production: {
        NODE_ENV: 'production',
        PATH: '/home/kuma/.nvm/versions/node/v24.11.0/bin:' + process.env.PATH,
      },
    },
  ],
};
```

```bash
chown kuma:kuma /home/kuma/ecosystem.config.js
```

### 8.3 Start both apps

```bash
sudo -u jss bash -c '
  source /home/jss/.nvm/nvm.sh
  pm2 start /etc/jss/ecosystem.config.js --env production
  pm2 status
'

sudo -u kuma bash -c '
  source /home/kuma/.nvm/nvm.sh
  pm2 start /home/kuma/ecosystem.config.js --env production
  pm2 status
'

### 8.4 Register PM2 startup hooks (mandatory two-step)

PM2 generates a systemd unit with the exact `PATH` including the nvm bin directory.
**Run `pm2 startup` as the service user — it prints a `sudo env PATH=...` command.
Copy-paste that exact output and run it as root.** Running `pm2 startup` directly as
root, or ignoring the printed command, produces a broken PATH at boot.

#### For `jss`:

```bash
# Step 1 — run as jss, prints the command to copy
sudo -u jss bash -c \
  'source /home/jss/.nvm/nvm.sh && pm2 startup systemd -u jss --hp /home/jss --service-name pm2-jss'

# Step 2 — copy and run the EXACT printed command as root, e.g.:
sudo env PATH=$PATH:/home/jss/.nvm/versions/node/v24.11.0/bin \
  /home/jss/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 \
  startup systemd -u jss --hp /home/jss --service-name pm2-jss
```

#### For `kuma`:

```bash
# Step 1
sudo -u kuma bash -c \
  'source /home/kuma/.nvm/nvm.sh && pm2 startup systemd -u kuma --hp /home/kuma --service-name pm2-kuma'

# Step 2 — copy and run the EXACT printed command as root, e.g.:
sudo env PATH=$PATH:/home/kuma/.nvm/versions/node/v24.11.0/bin \
  /home/kuma/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 \
  startup systemd -u kuma --hp /home/kuma --service-name pm2-kuma
```

### 8.5 Save process lists (mandatory)

`pm2 startup` registers the boot hook. `pm2 save` writes the dump file of processes
to resurrect. **Both steps are required — missing `pm2 save` means nothing restarts.**

```bash
sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 save'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 save'
```

### 8.6 Verify generated systemd units

```bash
systemctl status pm2-jss.service
systemctl status pm2-kuma.service
systemctl cat pm2-jss.service
systemctl cat pm2-kuma.service
```

Both should be `active (running)` with `WantedBy=multi-user.target`.

---

## 9. Nginx HTTP Scaffolding

### 9.1 Remove default site

```bash
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot
```

### 9.2 Temporary HTTP catch-all vhost

Create `/etc/nginx/sites-available/solidweb.app`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name solidweb.app *.solidweb.app;
    return 301 https://$host$request_uri;
}
```

```bash
ln -s /etc/nginx/sites-available/solidweb.app /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## 10. Let's Encrypt Wildcard Certificate (DNS-01)

### Why DNS-01?

`*.solidweb.app` wildcards cannot be issued via HTTP-01.
Let's Encrypt mandates DNS-01 for all wildcard SANs.

### One cert, all subdomains

| SANs | Stored at |
|------|-----------|
| `solidweb.app` + `*.solidweb.app` | `/etc/letsencrypt/live/solidweb.app/` |

### 10.1 Request (manual)

```bash
certbot certonly \
  --manual \
  --preferred-challenges dns \
  --server https://acme-v02.api.letsencrypt.org/directory \
  --agree-tos \
  --email you@example.com \
  -d solidweb.app \
  -d '*.solidweb.app'
```

### 10.2 Add two TXT records at your registrar

Certbot pauses **twice** — once per SAN. Both must coexist.

| Name | Type | Value |
|------|------|-------|
| `_acme-challenge.solidweb.app` | TXT | `<first token>` |
| `_acme-challenge.solidweb.app` | TXT | `<second token>` |

> Do **not** delete the first before adding the second.

### 10.3 Verify propagation before pressing Enter

```bash
dig TXT _acme-challenge.solidweb.app +short
# Both tokens must appear
```

### 10.4 Auto-renewal via DNS plugin

On Trixie, `python3-certbot-dns-cloudflare` 4.0.0 is available in the standard repos.

```bash
apt install -y python3-certbot-dns-cloudflare

cat > /etc/letsencrypt/cloudflare.ini <<'EOF'
dns_cloudflare_api_token = YOUR_API_TOKEN_HERE
EOF
chmod 600 /etc/letsencrypt/cloudflare.ini

certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  --server https://acme-v02.api.letsencrypt.org/directory \
  --agree-tos \
  --email you@example.com \
  -d solidweb.app \
  -d '*.solidweb.app'
```

> Other DNS provider plugins: https://certbot.eff.org/docs/using.html#dns-plugins

### 10.5 Nginx reload hook on renewal

```bash
cat > /etc/letsencrypt/renewal-hooks/post/reload-nginx.sh <<'EOF'
#!/bin/bash
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/post/reload-nginx.sh

systemctl status certbot.timer
certbot renew --dry-run
```

---

## 11. Nginx HTTPS Final Config

### 11.1 Shared TLS snippet

Create `/etc/nginx/snippets/ssl-params.conf`:

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers on;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
ssl_stapling on;
ssl_stapling_verify on;
resolver 1.1.1.1 8.8.8.8 valid=300s;
resolver_timeout 5s;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options SAMEORIGIN;
add_header X-Content-Type-Options nosniff;
```

### 11.2 status.solidweb.app (Uptime Kuma)

Create `/etc/nginx/sites-available/status.solidweb.app`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name status.solidweb.app;
    return 301 https://status.solidweb.app$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name status.solidweb.app;

    ssl_certificate     /etc/letsencrypt/live/solidweb.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/solidweb.app/privkey.pem;
    include snippets/ssl-params.conf;

    location / {
        proxy_pass          http://127.0.0.1:3001;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade    $http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_set_header    Host       $host;
        proxy_set_header    X-Real-IP  $remote_addr;
        proxy_set_header    X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header    X-Forwarded-Proto $scheme;
        proxy_read_timeout  3600s;
    }
}
```

### 11.3 monitor.solidweb.app (Netdata)

```bash
htpasswd -c /etc/nginx/.htpasswd admin
```

Create `/etc/nginx/sites-available/monitor.solidweb.app`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name monitor.solidweb.app;
    return 301 https://monitor.solidweb.app$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name monitor.solidweb.app;

    ssl_certificate     /etc/letsencrypt/live/solidweb.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/solidweb.app/privkey.pem;
    include snippets/ssl-params.conf;

    auth_basic           "Netdata — restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass         http://127.0.0.1:19999;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location ~ ^/api/v[0-9]+/stream {
        proxy_pass         http://127.0.0.1:19999;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
    }
}
```

### 11.4 solidweb.app + all pod subdomains (JSS)

Overwrite `/etc/nginx/sites-available/solidweb.app`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name solidweb.app *.solidweb.app;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;

    # Nginx resolves exact server_name matches before wildcards.
    # status.* and monitor.* are caught by their own blocks above.
    server_name solidweb.app *.solidweb.app;

    ssl_certificate     /etc/letsencrypt/live/solidweb.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/solidweb.app/privkey.pem;
    include snippets/ssl-params.conf;

    client_max_body_size 512m;

    # WebSocket: solid-0.1 notifications
    location ~ ^/\.notifications {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }

    # WebSocket: Nostr relay (if --nostr enabled later)
    location ~ ^/relay {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # Required for correct IDP issuer URL in subdomain mode
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### 11.5 Enable all sites and reload

```bash
ln -s /etc/nginx/sites-available/status.solidweb.app  /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/monitor.solidweb.app /etc/nginx/sites-enabled/
# solidweb.app already linked in step 9

nginx -t && systemctl reload nginx
```

---

## 12. Netdata

> **⚠️ Trixie-specific:** Netdata is **not in the Debian 13 Trixie official repositories**.
> Debian removed it because the project's web UI became closed-source software.
> `apt install netdata` will fail with "package not found" on Trixie.
>
> The correct and supported install path on Trixie is Netdata's own `kickstart.sh` script,
> which installs from `repository.netdata.cloud`. This repository does support Trixie.
> Do **not** try to manually point apt at the Bookworm Netdata repo — use kickstart.sh.

Netdata is not a Node.js process — PM2 is not involved. It runs under its own native
systemd service.

### 12.1 Install via kickstart.sh

```bash
wget -O /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh
sh /tmp/netdata-kickstart.sh --dont-start-it --stable-channel
```

> The kickstart script auto-detects Debian 13 Trixie and configures Netdata's own
> APT repository. If prompted to claim the agent to Netdata Cloud, you can decline —
> the local dashboard at `http://127.0.0.1:19999` works fully without cloud registration.

### 12.2 Bind to localhost only

Edit `/etc/netdata/netdata.conf`:

```ini
[web]
    bind to = 127.0.0.1:19999
```

### 12.3 Start and enable

```bash
systemctl enable --now netdata
systemctl status netdata
```

### 12.4 Verify

```bash
curl -s http://127.0.0.1:19999/api/v1/info | python3 -m json.tool | head -20
```

---

## 13. Firewall Rules

```bash
ufw allow OpenSSH        # always first
ufw allow 'Nginx Full'   # ports 80 + 443
ufw --force enable
ufw status verbose
```

> Ports 3000, 3001, 19999 remain closed — `127.0.0.1` only via Nginx.

---

## 14. Nginx Virtual Host Summary

| Incoming request               | Nginx match              | Backend             | Auth                |
|--------------------------------|--------------------------|---------------------|---------------------|
| `https://solidweb.app`         | exact `solidweb.app`     | JSS `:3000`         | Solid-OIDC / WAC    |
| `https://alice.solidweb.app`   | wildcard `*.solidweb.app`| JSS `:3000`         | Solid-OIDC / WAC    |
| `https://status.solidweb.app`  | exact (higher priority)  | Uptime Kuma `:3001` | Kuma login + 2FA    |
| `https://monitor.solidweb.app` | exact (higher priority)  | Netdata `:19999`    | HTTP Basic Auth     |
| `http://*`                     | all                      | → 301 HTTPS         | —                   |

---

## 15. Post-Install Checklist

### PM2

```bash
sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 status'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 status'
systemctl status pm2-jss.service
systemctl status pm2-kuma.service
```

### JSS — open registration + subdomain mode

```bash
curl -I https://solidweb.app
# Expected: HTTP/2 200

curl -I https://alice.solidweb.app/
# 200 or 401 — both confirm routing works

# Confirm subdomain mode: podUri must be at the subdomain
# With --idp enabled, POST /.pods requires email + password
curl -s -X POST https://solidweb.app/.pods \
  -H "Content-Type: application/json" \
  -d '{"name":"testpod","email":"test@example.com","password":"changeme123"}' \
  | python3 -m json.tool
# "podUri": "https://testpod.solidweb.app/"

# WebSocket notifications header
curl -I https://testpod.solidweb.app/public/
# Updates-Via: wss://testpod.solidweb.app/.notifications
```

Expected pod structure on disk (per official JSS docs):

```
/var/lib/jss/data/testpod/
├── index.html          ← WebID profile (HTML + JSON-LD)
├── .acl                ← Root WAC access control
├── inbox/              ← LDP inbox (public append)
│   └── .acl
├── public/
├── private/
│   └── .acl
└── settings/
    ├── prefs
    ├── publicTypeIndex
    └── privateTypeIndex
```

### Wildcard certificate

```bash
echo | openssl s_client -connect solidweb.app:443 -servername solidweb.app 2>/dev/null \
  | openssl x509 -noout -text | grep -A2 "Subject Alternative Name"
# Expected: DNS:solidweb.app, DNS:*.solidweb.app

for host in solidweb.app status.solidweb.app monitor.solidweb.app; do
  echo "=== $host ===" && echo | openssl s_client -connect "$host:443" 2>/dev/null \
    | openssl x509 -noout -dates
done
```

### Uptime Kuma

1. Open `https://status.solidweb.app`
2. Create admin account (no default password — first-run wizard)
3. Enable **2FA** in Settings → Security
4. Add monitors: `solidweb.app`, `alice.solidweb.app`, `status.solidweb.app`, `monitor.solidweb.app`, SSL cert for `solidweb.app` (alert 14 days before expiry)
5. Create a public Status Page

### Netdata

```bash
curl -s -u admin:yourpassword https://monitor.solidweb.app/api/v1/info | head -5
```

---

## 16. Maintenance & Useful Commands

### PM2 daily operations

```bash
sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 monit'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 monit'

sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 logs jss'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 logs uptime-kuma'

sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 reload jss'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 reload uptime-kuma'

sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 restart jss'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 restart uptime-kuma'
```

### Update JSS

```bash
su - jss -c 'source /home/jss/.nvm/nvm.sh && npm update -g javascript-solid-server'
sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && pm2 restart jss'
```

### Update Uptime Kuma

Uptime Kuma is updated by checking out the new release tag inside the cloned repo,
not via `npm update -g`. Check the [releases page](https://github.com/louislam/uptime-kuma/releases)
for the latest tag (e.g. `2.0.0`).

```bash
sudo -u kuma bash -c '
  source /home/kuma/.nvm/nvm.sh
  cd /var/lib/kuma
  git fetch --all --tags
  git checkout  --force
  npm install --omit=dev --no-audit
  npm run download-dist
'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 restart uptime-kuma'
```

### Update Netdata

```bash
wget -O /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh
sh /tmp/netdata-kickstart.sh --stable-channel
```

> The kickstart.sh script is also the update mechanism for kickstart-installed Netdata.

### Upgrade Node.js version

PM2 documentation: **re-run `pm2 startup` after every Node version change** — the binary
path changes with every new nvm-managed version.

```bash
NEW=24.12.0

for USER in jss kuma; do
  HOME_DIR="/home/$USER"
  sudo -u $USER bash -c "
    source $HOME_DIR/.nvm/nvm.sh
    nvm install $NEW
    nvm alias default $NEW
    npm install -g pm2
  "
done

# Re-run pm2 startup; copy-paste the printed sudo env command as root
sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 startup systemd -u jss  --hp /home/jss  --service-name pm2-jss'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 startup systemd -u kuma --hp /home/kuma --service-name pm2-kuma'

sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 update'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 update'

sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 save'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 save'

# Update PATH in ecosystem files
sed -i "s|v24\.11\.0|v${NEW}|g" /etc/jss/ecosystem.config.js
sed -i "s|v24\.11\.0|v${NEW}|g" /home/kuma/ecosystem.config.js
```

### Update PM2 itself

```bash
su - jss  -c 'source /home/jss/.nvm/nvm.sh  && npm install -g pm2@latest && pm2 update'
su - kuma -c 'source /home/kuma/.nvm/nvm.sh && npm install -g pm2@latest && pm2 update'

# Re-generate systemd units
sudo -u jss  bash -c 'source /home/jss/.nvm/nvm.sh  && pm2 startup systemd -u jss  --hp /home/jss  --service-name pm2-jss'
sudo -u kuma bash -c 'source /home/kuma/.nvm/nvm.sh && pm2 startup systemd -u kuma --hp /home/kuma --service-name pm2-kuma'
# Copy-paste the printed sudo env ... command as root for each
```

### Manage storage quotas

```bash
sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && jss quota show alice'
sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && jss quota set alice 2GB'
sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && jss quota reconcile alice'
```

### Manual certificate renewal

```bash
certbot renew --force-renewal
systemctl reload nginx
```

### set to mashlib current after JSS version update
```
# Go into the JSS package directory
cd /home/jss/.nvm/versions/node/v24.11.0/lib/node_modules/javascript-solid-server

# Install a specific mashlib version into it
sudo -u jss bash -c '
  source /home/jss/.nvm/nvm.sh
  cd /home/jss/.nvm/versions/node/v24.11.0/lib/node_modules/javascript-solid-server
  npm install mashlib@1.3.2
'

# Restart JSS
sudo -u jss bash -c 'source /home/jss/.nvm/nvm.sh && pm2 restart jss'
```
---

## Summary: Port & Service Map

| Service      | Managed by        | User   | Port   | Public URL                                              |
|--------------|-------------------|--------|--------|---------------------------------------------------------|
| JSS          | PM2 (`pm2-jss`)   | `jss`  | 3000   | `https://solidweb.app` + `https://*.solidweb.app`      |
| Uptime Kuma  | PM2 (`pm2-kuma`)  | `kuma` | 3001   | `https://status.solidweb.app`                          |
| Netdata      | systemd (native)  | root   | 19999  | `https://monitor.solidweb.app`                         |
| Nginx        | systemd (native)  | root   | 80/443 | All of the above                                       |

---
## Appendix: System Units

`/etc/systemd/system/pm2-jss.service`
```
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
PIDFile=/home/jss/.pm2/pm2.pid
TimeoutStartSec=30
User=jss
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games:/home/jss/.nvm/versions/node/v24.11.0/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
Environment=PM2_HOME=/home/jss/.pm2

Restart=on-failure

ExecStart=/home/jss/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/home/jss/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/home/jss/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
```
---
`/etc/systemd/system/pm2-kuma.service`
```
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
PIDFile=/home/kuma/.pm2/pm2.pid
TimeoutStartSec=30
User=kuma
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games:/home/kuma/.nvm/versions/node/v24.11.0/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
Environment=PM2_HOME=/home/kuma/.pm2

Restart=on-failure

ExecStart=/home/kuma/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/home/kuma/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/home/kuma/.nvm/versions/node/v24.11.0/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target

```
---

## Credits

The **JavaScript Solid Server (JSS)** is created by
**[Melvin Carvalho](https://melvin.me/)** — web pioneer, mathematician, Solid Protocol
enthusiast, and long-time contributor to the decentralised web. Melvin previously ran
`solid.community`, one of the original public Solid pod communities, and has been a key
figure in the development of WebID, Solid, and linked data on the web.

- Website: https://melvin.me/
- GitHub: https://github.com/melvincarvalho
- npm: https://www.npmjs.com/~melvincarvalho
- JSS: https://github.com/JavaScriptSolidServer/JavaScriptSolidServer
- JSS Docs: https://javascriptsolidserver.github.io/docs/

---

**Reference documents used:**
- Debian 13 Trixie release: https://www.debian.org/releases/trixie/
- JSS official docs: https://javascriptsolidserver.github.io/docs/
- JSS configuration reference: https://javascriptsolidserver.github.io/docs/reference/configuration
- JSS CLI reference: https://javascriptsolidserver.github.io/docs/reference/cli
- JSS HTTP API: https://javascriptsolidserver.github.io/docs/reference/api
- JSS pod structure: https://javascriptsolidserver.github.io/docs/reference/pod-structure
- JSS production guide: https://javascriptsolidserver.github.io/docs/guides/deploy-production
- Solid LLM Skills — servers: https://github.com/solid/solid-llm-skills/blob/main/solid/servers.md
- Netdata removed from Trixie: https://dietpi.com/blog/?p=4014
- Netdata Trixie issue tracker: https://github.com/netdata/netdata/issues/20773
- v5 source: https://hackmd.io/beBzcwbCSTaTx8gkT6Tr8g

---

*v6 — solidweb.app · 92.205.60.157 · Debian 13 Trixie (13.4) · Node.js 24.11.0 via nvm · PM2 · April 2026*
- -
this document: https://hackmd.io/4faoeQ_USYKMXjreAd3Ldg?view
