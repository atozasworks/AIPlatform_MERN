# ATOZAS AI — Operations guide

Self-hosted AI platform: Qwen3-4B-Instruct-2507 and four alternates on
llama.cpp, behind a Redis/BullMQ queue, streaming over SSE, with local RAG.
No third-party AI APIs.

```
Browser / PWA
      │
      ▼
Nginx (HTTPS, CloudPanel)          ports 80/443 — the only public surface
      │
      ▼
ATOZAS API (PM2 cluster ×2)        auth · rate limits · validation · SSE relay
      │
      ▼
Redis + BullMQ                     127.0.0.1:6379 — admission and queueing
      │
      ▼
LLM worker (PM2 fork ×1)           concurrency 2 — the hard CPU ceiling
      │
      ├─► llama-server chat        127.0.0.1:8081 — router, 5 Q4_K_M models
      └─► llama-server embeddings  127.0.0.1:8082 — Qwen3-Embedding-0.6B
                                   MongoDB — conversations, documents, vectors
```

---

## Windows 11 development

Prerequisites: Node 18+, MongoDB, Redis (via WSL2), and a llama.cpp CPU build
extracted to `.llamacpp-cpu\`.

```powershell
# One-time
cd C:\001work\ATOZASAIMERN\AIPlatform_MERN
cd server;  npm install;  cd ..
cd client;  npm install;  cd ..

# Redis under WSL2 (Redis has no official Windows build)
wsl --install -d Ubuntu                       # first time only
wsl -d Ubuntu -e sudo apt-get install -y redis-server

# Then, once per Windows session, before starting the API:
.\deploy\scripts\dev-redis.ps1

# Place the models
mkdir models
# Download into .\models\ with .\deploy\scripts\fetch-models.ps1, or by hand:
#   Qwen3-4B-Instruct-2507-Q4_K_M.gguf  (chat — newest, best default)
#   Qwen3-Embedding-0.6B-Q8_0.gguf      (embeddings, optional locally)
# The other chat models in deploy/MODELS.md are optional; the router serves
# whichever GGUFs are present and the picker greys out the rest.

# Terminal 1 — inference (uses 8081; 8080 is XAMPP Apache on this machine)
.\deploy\scripts\dev-llama.ps1 -Embeddings

# Terminal 2 — API
cd server;  npm run dev

# Terminal 3 — LLM worker (nothing generates without this)
cd server;  npm run dev:worker

# Terminal 4 — frontend
cd client;  npm run dev
```

Open http://localhost:5173.

Verify the stack:

```powershell
Invoke-RestMethod http://127.0.0.1:8081/health
Invoke-RestMethod http://localhost:5000/api/health/ready | ConvertTo-Json -Depth 5
```

**If chat returns 404**, `LLAMACPP_BASE_URL` is pointing at something that is
not llama-server. Check what owns the port:

```powershell
Get-NetTCPConnection -LocalPort 8081 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

**If generation fails with `ECONNREFUSED 127.0.0.1:6379` part-way through a
session**, WSL shut the distribution down and took Redis with it. Two WSL
behaviours cause this, and both were measured on this machine rather than
assumed:

- WSL2 stops an idle distribution within about a minute. Neither
  `vmIdleTimeout=-1` in `%USERPROFILE%\.wslconfig` nor a detached process
  *inside* the distribution prevents it — what WSL tracks is whether a
  Windows-side `wsl.exe` session is attached. `dev-redis.ps1` parks one and
  enables `redis-server` under systemd so it returns on its own.

  The holder is spawned through `Win32_Process.Create`, not `Start-Process`,
  because a `Start-Process` child belongs to the launching terminal's job
  object and is killed when that terminal closes — which silently takes Redis
  down a minute later. Check it is still there with:

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" |
    Where-Object { $_.CommandLine -match 'sleep infinity' }
  ```
- The default NAT networking mode relays Windows localhost into WSL, and that
  relay intermittently stops forwarding 6379: `redis-cli ping` succeeds inside
  WSL while Windows gets `ECONNREFUSED`. Fix it once, in
  `%USERPROFILE%\.wslconfig`:

  ```ini
  [wsl2]
  networkingMode=mirrored
  ```

  then `wsl --shutdown` and re-run `dev-redis.ps1`.

Note that `Test-NetConnection -Port 6379` reports **false negatives** against
WSL. Probe with a real command instead — `dev-redis.ps1` sends a Redis `PING`
and checks for `+PONG`.

When you are finished for the day:

```powershell
.\deploy\scripts\dev-redis.ps1 -Stop
wsl --shutdown                    # reclaims the VM's memory
```

---

## Hostinger Ubuntu VPS deployment

### 1. System packages

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl git build-essential jq bc ufw

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

sudo apt-get install -y redis-server mongodb-org
```

### 2. Bind data services to loopback

```bash
# Redis — must not be reachable from the network
sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
sudo sed -i 's/^# *protected-mode .*/protected-mode yes/' /etc/redis/redis.conf
# The queue holds transient job state, not a cache to be evicted under pressure
sudo sed -i 's/^# *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
sudo systemctl restart redis-server

# MongoDB — loopback only
sudo sed -i 's/^  bindIp:.*/  bindIp: 127.0.0.1/' /etc/mongod.conf
sudo systemctl enable --now mongod

# Confirm neither is publicly bound
sudo ss -tlnp | grep -E '6379|27017'   # expect 127.0.0.1 only
```

### 3. Firewall — only 80 and 443 public

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp        # keep your SSH port open first
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Ports 5000, 6379, 8081, 8082 and 27017 must **not** appear as allowed.

### 4. Inference layer

```bash
cd /path/to/AIPlatform_MERN
sudo bash deploy/scripts/install-llamacpp.sh     # reports lscpu/nproc/free, builds, verifies flags
sudo bash deploy/scripts/fetch-models.sh         # downloads + checksums
sudo systemctl enable --now atozas-llama atozas-llama-embed

systemctl status atozas-llama
curl -s http://127.0.0.1:8081/health
curl -s http://127.0.0.1:8082/health
journalctl -u atozas-llama -f
```

### 5. Benchmark before fixing the concurrency

Do not accept the default `--parallel 2` on faith.

```bash
sudo apt-get install -y jq bc
bash deploy/scripts/benchmark.sh
```

Then set, from the measured numbers:

- `LLAMA_PARALLEL`, `LLAMA_THREADS`, `LLAMA_THREADS_BATCH`, `LLAMA_CTX_SIZE` in
  `deploy/systemd/atozas-llama.service`
- `LLM_WORKER_CONCURRENCY` in `server/.env` — **must be ≤ `LLAMA_PARALLEL`**

**`LLAMA_CTX_SIZE` is the total, not the per-conversation window.** llama.cpp
divides `--ctx-size` evenly across the `--parallel` slots, so the value must be
`LLAMACPP_CONTEXT_WINDOW × LLAMA_PARALLEL` (8192 × 2 = 16384). Getting this
wrong halves every conversation's usable context with no error message. Confirm
after any change:

```bash
journalctl -u atozas-llama | grep n_ctx_slot     # expect n_ctx_slot = 8192
```

A reference sweep from a development machine (i7-11800H, 8 threads, 256-token
generations) is in `benchmark-results-windows-dev.txt`. It shows the shape to
expect — aggregate throughput rises with `--parallel` while per-stream speed
falls — but the absolute numbers do not transfer to the VPS. Measure there.

```bash
sudo cp deploy/systemd/atozas-llama.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart atozas-llama
```

### 6. Application

```bash
cp server/.env.example server/.env
# Fill in: JWT secrets, MONGO_URI, URLs, and the model checksums
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ×2

bash deploy/scripts/deploy.sh
pm2 startup systemd     # run the command it prints
pm2 save
```

### 7. Nginx

```bash
sudo cp deploy/nginx/atozas-sse.conf /etc/nginx/snippets/
# In the CloudPanel vhost for www.atozasai.com, inside the existing server{}:
#     include /etc/nginx/snippets/atozas-sse.conf;
# Keep every CloudPanel SSL line and template placeholder as-is.
sudo nginx -t && sudo systemctl reload nginx
```

### 8. Monitoring

```bash
# Watchdog every 5 minutes
sudo crontab -e
*/5 * * * * /bin/bash /path/to/AIPlatform_MERN/deploy/scripts/healthcheck.sh --quiet || logger -t atozas "health check failed"

# Cap the journal so inference logs cannot fill the disk
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=2G/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald

pm2 install pm2-logrotate
```

---

## Day-to-day operations

| Task | Command |
|---|---|
| Full health check | `bash deploy/scripts/healthcheck.sh` |
| Live inference logs | `journalctl -u atozas-llama -f` |
| Application logs | `pm2 logs atozas-api` / `pm2 logs atozas-worker` |
| Platform status (admin) | `curl -s localhost:5000/api/v1/admin/ai/status -H "Cookie: …" \| jq` |
| Restart inference | `sudo systemctl restart atozas-llama` |
| Restart the worker | `pm2 restart atozas-worker` |
| Pause generation | `POST /api/v1/admin/ai/queue/pause` |
| Deploy | `bash deploy/scripts/deploy.sh` |
| Roll back | `bash deploy/scripts/rollback.sh` |

### Reading the symptoms

| Symptom | Likely cause | Action |
|---|---|---|
| 404 from the engine | Wrong port; something else is listening | `ss -tlnp \| grep 8081` |
| Answers arrive all at once | Nginx buffering the SSE route | Confirm the snippet is included and `nginx -t` passes |
| Queue depth climbing | Concurrency below demand | Benchmark; raise `--parallel` and `LLM_WORKER_CONCURRENCY` together |
| Very slow generation | Swap in use | `free -m`; lower `LLAMA_PARALLEL` or `--ctx-size` |
| Breaker stuck open | llama-server crash-looping | `journalctl -u atozas-llama -n 100` |
| Citations missing | Embedding server down | `curl 127.0.0.1:8082/health`; retrieval is keyword-only meanwhile |
| Generations double after deploy | Worker in cluster mode | `pm2 jlist` — must be exactly one `atozas-worker` |
