# Deploying the judges' sandbox

The public sandbox (`/try`, see [runbook.md](runbook.md#the-judges-sandbox)) ships as one small container. There are two ways to put it online:

| | AWS Lightsail container service | Cloudflare quick tunnel |
|---|---|---|
| Command | `make deploy-aws` | `make tunnel` |
| URL | `https://auren-sandbox.<id>.us-east-2.cs.amazonlightsail.com/try`, stable | `https://<random>.trycloudflare.com/try`, new each run |
| Cost | $7/month flat (nano), prorated hourly | Free |
| Up while | Always, until `make teardown-aws` | This Mac is awake and the script runs |
| `AUREN_TRUST_PROXY` | `1` (Lightsail's load balancer) | `1` (Cloudflare's edge) |

Both run the same image, with the same limits, and neither needs your real Core running.

## The image
```bash
make sandbox-image                                    # docker build -t auren-sandbox:local .
docker run --rm -p 127.0.0.1:8080:8080 auren-sandbox:local   # http://127.0.0.1:8080/try, replays without a key
```
- `node:24-alpine`, runs as the `node` user, `AUREN_SANDBOX=true`, `HOST=0.0.0.0`, `PORT=8080`, and a `HEALTHCHECK` on `/health`.
- It holds only what sandbox mode reads: `core/src` (no tests) with production dependencies, `apps/web/try.html`, `brand/tokens.css` and `mark.svg`, `eval/cases`, `eval/scripts`, and `router/auren_router/system_prompt.txt` (Core's entry point imports the router, which reads its prompt when the module loads).
- **No secret can be baked in.** `.dockerignore` is an allow-list: only those paths reach the Docker daemon, and `.env*`, keys, certs, databases, `film/` and `node_modules` are excluded again on top. `MODEL_API_KEY` is only ever passed when the container starts.
- It writes nothing to disk, so it runs with `--read-only --cap-drop ALL`.
- Size: about 70 MB compressed (what's pushed and pulled). Docker Desktop lists 312 MB, which counts the compressed and unpacked copies. It uses about 92 MB of memory idle and about 105 MB with 45 visitors.
- CI builds it on every push and smoke-tests it in replay mode. CI never pushes it.

## Path 1: AWS (Lightsail container service)

### Why Lightsail
| Option | Status (Nov 2026) | Cost for one small container | Verdict |
|---|---|---|---|
| **Lightsail container service** | Available | **$7/month** (nano: 0.25 vCPU, 512 MB), HTTPS URL, load balancer and registry included, 500 GB transfer a month | **Chosen**: the cheapest and simplest. One command, nothing else to create. |
| ECS Express Mode | Available | About $30/month: an Application Load Balancer (about $16 to $19) plus a Fargate task (0.25 vCPU, 0.5 GB, about $9) plus a public IPv4 address | Better secret handling (injects from Secrets Manager), but four times the price and more moving parts. The upgrade path if the sandbox outlives the hackathon. |
| App Runner | Closed to new customers since April 30, 2026 | n/a | Not an option. |

### Cost
| Item | Cost |
|---|---|
| Lightsail container service, nano x 1 | $7.00/month ($0.0094/hour), charged from creation to deletion, even when idle |
| Data transfer | 500 GB/month included; `/try` is about 36 KB. Above that, $0.09/GB in us-east-2 |
| SSM Parameter Store (standard SecureString) | Free |
| AWS Budget (no actions) | Free |
| **Three weeks of judging** | **About $5** |

`POWER=micro` (1 GB) is $10/month if you want headroom. Keep `SCALE=1`: each visitor's world lives in one process's memory, and Lightsail doesn't pin a visitor to a node.

### Deploy
Needs the AWS CLI v2 signed in (`aws sts get-caller-identity` works), Docker running, and `jq`.
```bash
make deploy-aws                      # = deploy/aws/deploy.sh: shows the plan and price, asks, deploys
deploy/aws/deploy.sh --yes           # no prompt
deploy/aws/deploy.sh --replay        # no key: every command replays
deploy/aws/status.sh                 # read-only: state, URL, versions, /health
```
It is idempotent: re-run it to ship a new version. What it does:
1. Reads `MODEL_API_KEY` from `.env` (that one line; the file is never sourced) and stores it as the SSM SecureString `/auren/sandbox/MODEL_API_KEY`. Without one in `.env`, it uses the SSM copy from an earlier run, and failing that it deploys in replay mode.
2. Creates the Lightsail container service `auren-sandbox` in `us-east-2` (nano x 1) if it's missing, and waits until it's ready.
3. Builds the image for `linux/amd64` (Lightsail runs x86) and pushes it into the service's own registry (no ECR repository, no `lightsailctl` plugin needed).
4. Deploys it with port 8080 public, a health check on `/health`, and this environment:

   | Variable | Value | Why |
   |---|---|---|
   | `AUREN_TRUST_PROXY` | `1` | See below |
   | `AUREN_SANDBOX_TOKEN_BUDGET` | `200000` | Live Muse tokens across all visitors; then replay |
   | `AUREN_TOKEN_LIMIT` | `250000` | The spend guard's hard stop, a backstop above the budget |
   | `AUREN_SANDBOX_RPM`, `_DAILY`, `_MAX_VISITORS` | `6`, `60`, `50` | The sandbox's defaults, stated |
   | `AUREN_TZ` | `America/Los_Angeles` | The container's clock is UTC |
   | `MODEL_API_KEY` | from SSM | Omitted in replay mode |

5. Waits for the deployment to be active, then prints the URL and `/health`.

Every value can be overridden from the environment, such as `TOKEN_BUDGET=100000 POWER=micro AWS_REGION=us-west-2 make deploy-aws`. The defaults live in [deploy/aws/common.sh](../deploy/aws/common.sh).

**`AUREN_TRUST_PROXY=1`.** On Lightsail the container sees the load balancer's address, not the visitor's. The load balancer appends the address it saw to `X-Forwarded-For`, so the last entry is the only one a visitor can't forge, and that's what one trusted hop believes. If there turned out to be a second hop, the cost of `1` is that visitors behind it would share one set of rate limits; addresses still couldn't be forged. Setting it too high would be the unsafe mistake. After the first deploy, check that `aws lightsail get-container-log --service-name auren-sandbox --container-name sandbox` has no `sandbox.proxy` warning, and that two networks get separate limits.

**How the key travels.** It only moves through stdin pipes (`.env` to `ssm put-parameter`, SSM to `jq` to `create-container-service-deployment`). It never appears in a command line, a file, a log line or the script's output, and the scripts only ever select non-secret fields from AWS responses. Lightsail has no secret injection, though, so the key ends up in the deployment's environment, readable by anyone in this AWS account allowed `lightsail:GetContainerServiceDeployments`. For a single-person account during judging, that's acceptable. If it isn't for you, use ECS Express Mode, which injects the key from Secrets Manager at start-up.

### Budget alarm
```bash
BUDGET_EMAIL=you@example.com deploy/aws/budget.sh                 # $15/month
BUDGET_EMAIL=you@example.com BUDGET_USD=10 deploy/aws/budget.sh
```
It creates a monthly cost budget, `auren-sandbox`, that emails you at 50% and 80% of actual spend and at 100% of forecast. It covers the whole account. Budgets without actions are free. You can set the same thing up in the console under Billing, Budgets, Create budget, Monthly cost budget.

### Tear down
```bash
make teardown-aws                    # = deploy/aws/teardown.sh: asks, then deletes
```
It deletes the container service (with its images and deployments, which stops all charges), the SSM parameter, and the budget. It's safe to re-run.

## Path 2: free, from this Mac (Cloudflare quick tunnel)
```bash
make tunnel                          # = deploy/tunnel.sh: builds and runs the container, then the tunnel
deploy/tunnel.sh --node              # npm run sandbox instead of Docker
deploy/tunnel.sh --replay            # don't pass the key
deploy/tunnel.sh --check             # start locally, check /health and /try, stop; no tunnel
```
- The sandbox listens on `127.0.0.1:8790` only (not 8787, so your real Core can keep running). `cloudflared` dials out, and nothing on the Mac is opened to the network.
- `AUREN_TRUST_PROXY=1`: Cloudflare's edge is the one hop that appends the visitor's address. Neither `cloudflared` nor Docker's port forward adds an entry.
- With Docker, only `MODEL_API_KEY` is read from `.env` and passed by name (`-e MODEL_API_KEY`), so the value isn't on a command line and the rest of `.env` never reaches the container.
- Give judges `https://<the printed host>/try`. Ctrl-C stops the tunnel and the sandbox. The URL changes every run, and it works only while the Mac is awake.

## The safety model
- **It never touches a real account.** Sandbox mode exits before Core opens `auren.db`, the master key, connector tokens, paired devices, the camera or the driver. It serves only `/try`, `/try/api/*`, `/health` and the brand assets; `/v1/*` and every other route answer 404, and WebSocket upgrades are dropped. Each visitor gets their own fictional demo world in memory. Details: [SECURITY.md](../SECURITY.md#the-public-sandbox).
- **Rate limits.** Per visitor address: 6 commands a minute, 60 a day, 600 requests a minute, 3 sessions. Overall: 50 visitors and 12 commands at once. Commands are at most 280 characters.
- **Token budget, then replay.** The live engine spends at most `AUREN_SANDBOX_TOKEN_BUDGET` tokens, then the golden paths replay from `eval/scripts` through the real loop. `AUREN_TOKEN_LIMIT` is the hard stop behind it. Both count in memory, so **a restart or redeploy starts them from zero**: the most one container can spend is the budget times the number of times it starts. Lightsail restarts a container only when it fails its health check or you deploy.
- **The page** has a strict Content-Security-Policy with a per-response nonce, and no framing.
- **The container** runs as a non-root user and needs no writable disk.
- **Rotate the key after judging.** Create a new `MODEL_API_KEY` at dev.meta.ai, revoke the old one, then `make teardown-aws` (or redeploy with the new key in `.env`). Deleting the SSM parameter doesn't revoke anything.

## Before you share the link
1. `curl <url>/health` says `"sandbox": true`, and `engine` is `live` (or `replay`, if that's what you meant).
2. Open `/try` and play GP1 to its tap.
3. `curl -s -o /dev/null -w '%{http_code}' <url>/v1/events` prints `404`.
