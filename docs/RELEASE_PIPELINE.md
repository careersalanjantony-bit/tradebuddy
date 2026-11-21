# TradeBuddy release pipeline

From "a feature is finished" to "the phone shows **Update now**" with no SSH, no manual workflow run, no
APK download or upload. Status: **implemented and dry-run tested; NOT switched on.** It does nothing to
production until the owner completes section 6 and sets `RELEASE_AUTOMATION=on` (section 7).

```
feature PR (version + release notes)                       public repo: careersalanjantony-bit/tradebuddy
   │  CI "checks": type checks, all tests, builds, release gate, smoke   (no secrets)
   ▼
owner merges to main  ──►  CI on main  ──►  release-tag.yml: annotated tag v<version>   (immutable)
                                                   │
private repo (tradebuddy-keys) release.yml, every 15 min ◄──┘
   plan ─► validate ─► signed APK ─► server deploy (OIDC → IAM role → Systems Manager) ─► publish to `updates`
                                         │                                                │
                                   EC2: deploy-release.sh                       phones: "Update now"
                                   (backup, checks, safe rollback)              (checked every 5 minutes)
```

## 1. The normal release (what Claude does, what the owner does)

1. **Claude** implements the feature on a branch, raises the version in `package.json` and
   `package-lock.json` (`npm version x.y.z --no-git-tag-version --ignore-scripts`), writes
   `release-notes/x.y.z.txt` (1–12 plain lines, shown on the phone), runs `npm run typecheck`,
   `npm run server:typecheck`, `npx vitest run`, `npm run build`, `npm run server:build`, `npm run smoke`, and
   opens a pull request to `main`. CI runs the same checks again (`.github/workflows/ci.yml`).
2. **The owner** merges the pull request (the approval: only reviewed code on `main` is ever released;
   Claude merges only when the owner explicitly asks).
3. **Automatic from here:** CI on `main` → `release-tag.yml` creates the annotated tag `vx.y.z` → within
   about 15 minutes `release.yml` (private repository) picks it up → validate, build the signed APK, deploy
   the server, publish → the app finds it at its next check (every 5 minutes) → **Update now** → Android
   asks to install (that tap is the only manual step).

A commit is a **release** when its version is higher than the newest `v*` tag. A commit with the same
version is an ordinary change (CI only). A lower version fails CI.

**Typical time from merge to "Update now":** CI ≈ 8 min, wait for the next run ≤ 15 min, validate + APK
≈ 15 min, server deploy ≈ 3–5 min. About 30–45 minutes. A server deploy never starts during market hours
(Mon–Fri 09:00–15:40 IST): it waits until after the close.

## 2. What a release does: server, app or both

`scripts/release/lib.mjs` decides from the changed files between what production runs and the tag:

| Changed | Server | App |
| --- | --- | --- |
| `server/**` | deploy | — |
| `src/ui/**`, `src/main.tsx`, `android/**`, `public/**`, `index.html`, `vite.config.ts` | — | publish |
| other `src/**` (shared code: the server bundles it) | deploy | publish |
| `package.json` / lock: dependencies | deploy | publish |
| only the version, docs, tests, CI, release notes | — | — |
| anything unknown | deploy | publish |

"What production runs" = the server's `/healthz` version and the `updates` branch's `latest.json`. Steps
always run in this order: **validate → build the APK → deploy the server → publish the APK**. A coordinated
release builds and verifies the APK before the server changes, and phones are offered the app only after
its server runs.

## 3. Safety rules (and where they are enforced)

* **Only approved code:** a release is an *annotated* `v<x.y.z>` tag (made by `release-tag.yml` after CI
  passed for a push to `main`), whose commit is on `main` and whose CI job `checks` passed — checked again by
  the private workflow (`release-target.mjs`) before anything happens. Pull requests, other branches and
  forks never reach the pipeline. Tags are never moved; the deploy re-checks on the server that the tag is
  exactly the commit.
* **Secrets stay where they are:** public CI has no secrets. Signing keys, passwords and lineage stay in the
  private repository and are checked out only in the APK build job (as before); `google-services.json` comes
  from the `GOOGLE_SERVICES_JSON` secret. AWS access is a short-lived OIDC session for one job in the
  `production` environment; there is no AWS key anywhere. The `updates` branch is written with a GitHub App
  token limited to the public repository. `/etc/tradebuddy/server.env`, the Firebase key, the systemd unit
  and Caddy are never touched by a deploy, and nothing prints a secret (tested).
* **Data and the cloud auto-trader:** before the switch the server stops cleanly, takes a consistent backup
  with SQLite's backup API, checks it (`integrity_check`, schema) and keeps it
  (`/var/backups/tradebuddy/deploy-<time>-v<version>/`, newest 10). After the start the deploy checks ready,
  version, commit, contract (`botApi`), database schema, and that the auto-trader has the **same owner**
  (mode, epoch, controlling phone) and did not go back in history.
* **Rollback only when it is safe:** if the new release fails its checks and the database schema did not
  change, the previous release is put back automatically (same database, nothing lost). If a migration ran,
  **nothing is rolled back automatically** (an older build cannot open a newer database; restoring the
  backup would lose new data) — the run fails with the backup's path and section 8's steps.
* **No loops:** a release that failed in production is never retried automatically (only as a new version
  or with `retry_failed_deploy`); a build that failed before anything changed is retried at most every 2 h.
* **One at a time:** the workflow's `concurrency` group, a lock on the server, `--force-with-lease` on the
  `updates` branch, and the tagger's own `concurrency` group.
* **Publication is all-or-nothing:** one commit with the APK, `latest.json` and README, pushed with a lease,
  read back; never an older or equal version; the APK published is byte-identical (SHA-256) to the one
  verified (package, version, versionCode, Firebase project, both certificates, rotation lineage, no secrets
  inside — the same checks as the manual build).
* **Read-only towards the broker:** nothing in the pipeline (or TradeBuddy) places, changes or cancels an
  order; the dry run checks no order address is ever called.

## 4. The server deploy (`server/deploy/deploy-release.sh`)

Run as root on EC2 by Systems Manager. The command sent is fixed and small (`ssm-deploy.sh`): fetch the tag
from GitHub, check it is the commit, run the deploy script **from that commit**. The script builds the
release in `/opt/tradebuddy-releases/stage-<sha>` while the old server keeps running (npm ci, server build,
server tests, `--version-info`), then stops, backs up, swaps directories (`/opt/tradebuddy` ↔ the previous
one kept as `prev-…`), starts and checks. Full log: `/var/log/tradebuddy-deploy/`.

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `deployed` | the new release runs; all checks passed | nothing |
| `already` | it already ran this release (a replay) | nothing |
| `refused` | wrong tag/commit, a build older than the database, not enough disk | nothing changed; fix and release a new version |
| `build_failed` / `backup_failed` | failed before the switch | nothing changed; the old server runs (retried after 2 h) |
| `rolled_back` | failed after the switch, same schema → previous release back | nothing lost; fix and release a new version |
| `failed_no_rollback` | failed after a **migration** | section 8: decide by hand (the backup is ready) |
| `rollback_failed` | the previous release did not come back | section 8 at once |
| `refused_failed_before` / `waiting` | this release failed before; not retried automatically | release a fix, or `retry_failed_deploy` |

## 5. Dry runs (nothing in production changes)

* **Locally:** `npm run release:rehearse` — a local copy of GitHub, the real server of the tag
  `m5-cloudbot-rc1` running as "production" with the cloud auto-trader on (cloud, controlling phone), a
  release `x.y.z+1` going through the gate, the tagger, the target check, the plan, the **exact Systems
  Manager command under `dash`** (real `npm ci`, build, server tests), the checks (version, commit, the
  auto-trader's owner and state digest, backup integrity, no secret in any output), a replay, the publish to
  a local copy of the `updates` branch, and then a broken release that never starts → automatic rollback.
  Last result: 20/20.
* **On GitHub, after the private pull request is merged:** Actions → *Release TradeBuddy* → Run workflow →
  mode `dry-run`. It runs plan, validate and the **signed** APK build, prints the exact deploy command and the
  exact `latest.json`, and changes nothing (no AWS session, no push).
* **Tests:** `tests/release/` (deploy script in a sandbox, rules, gate, plan, publish, workflow safety) and
  `tradebuddy-keys/.github/tests/` (target, Systems Manager with a stand-in `aws`, the remote command under
  `dash`, workflow order and permissions).

## 6. One-time setup (the owner)

Nothing here needs a secret pasted into a chat or an issue. Region below: `ap-south-1` (Mumbai) — use yours.

### 6.1 Bring `main` up to date (once)

Production runs the cloud auto-trader (`m5-cloudbot-rc1`), which is still on pull requests. Merge, in this
order: #4 (Milestone 4) → #5 → #6 → the pipeline pull request. Then `main` holds exactly what runs, plus the
pipeline. The first CI run on `main` tags it `v1.22.0` (the baseline). The pipeline then sees: server 1.22.0
= current; the `updates` branch still offers 1.20.2 → it publishes 1.22.0 (phones already on 1.22.0 are not
offered anything; older phones get 1.22.0).

### 6.2 GitHub — public repository (`tradebuddy`)

1. **Settings → Rules → Rulesets → New tag ruleset** "Release tags": target `v*`; enable *Restrict
   updates* and *Restrict deletions* (tags never move). Do not restrict creations (the tagger creates them).
2. **Rulesets → "Protect main"** (exists): add *Require status checks to pass* → `checks`; optionally
   *Require a pull request before merging* (0 approvals is fine for a single owner).
3. **Settings → Actions → General → Workflow permissions:** "Read repository contents" (the tagger asks for
   tag-write itself).

### 6.3 GitHub App for the `updates` branch (no broad personal token)

1. **Your profile → Settings → Developer settings → GitHub Apps → New GitHub App**: name e.g.
   "TradeBuddy release"; homepage any URL; untick Webhook; **Repository permissions → Contents: Read and
   write** (nothing else); "Only on this account".
2. Create → **Generate a private key** (a `.pem` downloads) → note the **App ID**.
3. **Install App** → only `careersalanjantony-bit/tradebuddy`.
4. In **tradebuddy-keys → Settings → Secrets and variables → Actions**: secret `RELEASE_APP_PRIVATE_KEY` =
   the whole `.pem` text; variable `RELEASE_APP_ID` = the App ID. Then delete the downloaded `.pem`.

### 6.4 GitHub — private repository (`tradebuddy-keys`)

1. **Settings → Environments → New environment** `production` → *Deployment branches and tags*: **Selected
   branches** → `main`. (No reviewers needed; add yourself if you want to approve every deploy.)
2. **Variables** (Settings → Secrets and variables → Actions → Variables):
   `AWS_REGION` = `ap-south-1`, `AWS_DEPLOY_ROLE_ARN` = (6.5), `TB_INSTANCE_ID` = your EC2 instance id
   (`i-…`), `TB_PUBLIC_URL` = `https://<your server's domain>` (no trailing slash), and
   `RELEASE_AUTOMATION` = `off` (switch on in section 7).
3. Secrets: `GOOGLE_SERVICES_JSON` (exists), `RELEASE_APP_PRIVATE_KEY` (6.3).

### 6.5 AWS — GitHub OIDC, the deploy role, Systems Manager (AWS CloudShell)

1. **OIDC provider** (once per account; skip if `token.actions.githubusercontent.com` already exists):

   ```bash
   aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
   ```

2. **The role**, trusted only by the private repository's `production` environment:

   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   cat > trust.json <<EOF
   {"Version":"2012-10-17","Statement":[{"Effect":"Allow",
     "Principal":{"Federated":"arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"},
     "Action":"sts:AssumeRoleWithWebIdentity",
     "Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
       "token.actions.githubusercontent.com:sub":"repo:careersalanjantony-bit/tradebuddy-keys:environment:production"}}}]}
   EOF
   aws iam create-role --role-name tradebuddy-github-deploy --assume-role-policy-document file://trust.json --max-session-duration 3600
   ```

3. **Its permissions** — run one command on that one instance, read the result, nothing else:

   ```bash
   REGION=ap-south-1; INSTANCE=i-xxxxxxxxxxxxxxxxx
   cat > deploy.json <<EOF
   {"Version":"2012-10-17","Statement":[
     {"Effect":"Allow","Action":"ssm:SendCommand","Resource":[
       "arn:aws:ssm:$REGION::document/AWS-RunShellScript",
       "arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE"]},
     {"Effect":"Allow","Action":["ssm:GetCommandInvocation","ssm:ListCommandInvocations","ssm:DescribeInstanceInformation"],"Resource":"*"}]}
   EOF
   aws iam put-role-policy --role-name tradebuddy-github-deploy --policy-name send-deploy-command --policy-document file://deploy.json
   aws iam get-role --role-name tradebuddy-github-deploy --query Role.Arn --output text   # → AWS_DEPLOY_ROLE_ARN
   ```

4. **The instance must be managed by Systems Manager.** EC2 → the instance → Actions → Security → *Modify IAM
   role*: a role with the AWS managed policy **AmazonSSMManagedInstanceCore** (create one "tradebuddy-ec2-ssm"
   if the instance has none). The SSM agent is pre-installed on Ubuntu 24.04 AMIs; check and verify:

   ```bash
   aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text   # Online
   ```

   (If not Online after a few minutes: on the instance `sudo snap services amazon-ssm-agent`, and outbound
   HTTPS must be allowed — it is by default. No inbound port is needed; SSH can stay closed to the world.)

5. **A harmless first command** (proves the path, changes nothing):

   ```bash
   aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --parameters 'commands=["cd /opt/tradebuddy && git rev-parse HEAD && node --version && df -h / | tail -1"]' --query Command.CommandId --output text
   ```

   Then Systems Manager → Run Command → that command → Output.

### 6.6 Check everything with a GitHub dry run

Actions → *Release TradeBuddy* → Run workflow → `dry-run`. Expected: plan shows the target tag, the production
versions and the plan; validate and the signed APK pass; the deploy job prints the exact command; publish
prints the exact `latest.json`. Nothing changes.

## 7. Switching on (only with the owner's explicit approval)

Set the variable `RELEASE_AUTOMATION` = `on`. From then on every new `v*` tag is released automatically.
To pause at any time: set it to `off` (runs in progress finish; nothing new starts). A manual `live` run also
requires `on`.

## 8. Recovery

* **A failed run** is visible in Actions (GitHub e-mails the owner) and in its summary: which step, the
  deploy outcome and the backup. Nothing after the failed step happened; phones are not offered anything.
* **Replay:** fix the cause and release a new version (normal), or run *Release TradeBuddy* manually with
  `live` (+ `retry_failed_deploy` if the deploy failed in production before). Every step is safe to repeat:
  the deploy says `already`, the publish says `already-published`.
* **`failed_no_rollback` (after a migration)** — the new release runs (or tries to). Choose:
  1. Keep it and release a fix (preferred: no data lost); or
  2. go back to the previous release, accepting the loss of what was written since the deploy (on the
     server, as root):

     ```bash
     sudo systemctl stop tradebuddy-server
     B=/var/backups/tradebuddy/deploy-<time>-v<version>        # from the run summary
     sudo mv /opt/tradebuddy /opt/tradebuddy-releases/failed-manual-$(date +%s)
     sudo mv /opt/tradebuddy-releases/prev-<sha>-<time> /opt/tradebuddy   # from the run summary / log
     sudo rm -f /var/lib/tradebuddy/tradebuddy.db-wal /var/lib/tradebuddy/tradebuddy.db-shm
     sudo cp "$B/tradebuddy.db" /var/lib/tradebuddy/tradebuddy.db && sudo chown tradebuddy:tradebuddy /var/lib/tradebuddy/tradebuddy.db
     sudo systemctl start tradebuddy-server && curl -s http://127.0.0.1:8787/healthz
     ```
* **`rollback_failed`:** the same steps as (2), at once (the server is down).
* **Lost instance:** the newest deploy backup + `/etc/tradebuddy/server.env` + the Firebase key are what a new
  instance needs (server/README.md, "Deploy on AWS"). Keep an off-instance copy of the backups if you can.
* **Rotate the GitHub App key:** generate a new private key in the App, replace `RELEASE_APP_PRIVATE_KEY`,
  delete the old key in the App.
