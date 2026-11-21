# Cloud alerts with Firebase — setup guide

This turns on **cloud alerts** (milestone 4): your TradeBuddy server on AWS sends its alerts to your phone
through Google's Firebase Cloud Messaging (FCM), so they arrive even when the app is closed or the phone
was off for a while.

Before you start, know this:

* **It is optional.** Without it the app works exactly as before (it alerts by itself while it runs).
* **Delivery is best effort.** Google, your network and your phone's battery saver decide when a
  notification really shows. An alert can arrive late or not at all. Don't rely on it alone.
* **It is free.** FCM costs nothing and the free Firebase plan (Spark) is enough. You don't need a card.
* **Nothing here can trade.** The server and the app stay read-only towards Upstox: no orders, no GTTs.
* **Three files or values must never go into GitHub, a chat or an e-mail:** the Firebase service-account
  key (step 4), the server's `TB_API_TOKEN`, and your Upstox tokens. `google-services.json` (step 3) is
  not as secret, but keep it out of the public repository too. `.gitignore` already blocks all of them.

What you need: a Google account, the TradeBuddy server already running on AWS (see
[server/README.md](../server/README.md)), the computer you build the APK on, and about an hour.

---

## Step 1 — Create a Firebase project

1. Open <https://console.firebase.google.com> and sign in with your Google account.
2. Click **Create a project** (or **Add project**).
3. Name it, for example `TradeBuddy`. Firebase adds a short code to the project ID. That's fine.
4. Google Analytics: you can turn it **off**, because TradeBuddy doesn't use it.
5. Click **Create project** and wait until it says it is ready.

## Step 2 — Register the Android app

1. On the project's home page, click the **Android** icon ("Add app").
2. **Android package name:** `in.tradebuddy.app`. It must match exactly, or push will not work.
3. App nickname: anything (for example `TradeBuddy phone`).
4. "Debug signing certificate SHA-1": **leave it empty**, because FCM doesn't need it.
5. Click **Register app**.

## Step 3 — `google-services.json` (the app's Firebase settings)

1. Firebase now offers **Download google-services.json**. Download it.
   (You can download it again any time: ⚙️ **Project settings** → **General** → your Android app.)
2. Skip the remaining wizard steps ("Add Firebase SDK", etc.). TradeBuddy's build already does that.
3. Put the file in **one** of these two places:
   * the root of your **private** `tradebuddy-keys` repository (recommended). `npm run apk`
     (`scripts/build-apk.mjs`) copies it into the build each time.
   * or straight into `android/app/google-services.json` in the TradeBuddy folder. Git ignores it there.
4. Build the APK as usual (`npm run apk`). The build prints
   `Firebase: on (google-services.json found)`. If it prints `Firebase: off`, the file was not found. That
   app still works, but its Cloud alerts card will say it was built without Firebase.

> Never commit `google-services.json` to the public TradeBuddy repository. The build ignores the file if
> it is missing, so nothing breaks for anyone else.

## Step 4 — FCM HTTP v1 and the server's key

The server sends through the **FCM HTTP v1 API**. The old "legacy server key" is gone and is not used.

**4a. Check that the API is on**

1. ⚙️ **Project settings** → **Cloud Messaging** tab.
2. Under **Firebase Cloud Messaging API (V1)** it should say **Enabled**.
3. If it is disabled, use the ⋮ menu or the link there to open Google Cloud Console and click **Enable**.

**4b. Create the service-account key (a secret!)**

1. ⚙️ **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → **Generate key**. A `.json` file downloads.
3. Treat this file like a password. Anyone who has it can send notifications as your project.
   Don't upload it to GitHub, Google Drive, a chat or e-mail.

*Optional, safer:* the default key is allowed to do much more than send notifications. You can instead
create a separate service account for TradeBuddy. Do this in Google Cloud Console → **IAM & Admin** →
**Service accounts** → **Create service account**. Give it only the role **Firebase Cloud Messaging API
Admin**, then use **Keys** → **Add key** → **JSON**. The server works the same with either key.

## Step 5 — Put the key on the AWS server (safely)

From your computer, copy the key to the server's home folder. Use your own key file name and server
address:

```bash
scp -i ~/.ssh/your-ec2-key.pem tradebuddy-xxxxx-firebase-adminsdk-xxxxx.json ubuntu@YOUR-EC2-ADDRESS:~/firebase-key.json
```

Then, on the server (`ssh` in first):

```bash
# readable only by root and the TradeBuddy service, outside the code folder
sudo install -m 640 -o root -g tradebuddy ~/firebase-key.json /etc/tradebuddy/firebase-service-account.json
shred -u ~/firebase-key.json                        # remove the copy in your home folder

# tell the server where it is
echo 'FIREBASE_SERVICE_ACCOUNT_FILE=/etc/tradebuddy/firebase-service-account.json' | sudo tee -a /etc/tradebuddy/server.env
sudo systemctl restart tradebuddy-server

# check: "configured": true and your project id (the key itself is never shown or logged)
TOKEN=$(sudo sed -n 's/^TB_API_TOKEN=//p' /etc/tradebuddy/server.env)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/push
```

After that, delete the downloaded key from your computer's Downloads folder. If you want a backup,
keep it in a password manager, not in a Git repository.

The systemd service is unchanged: it can read `/etc/tradebuddy` (read-only) and reach Google over the
internet.

## Step 6 — HTTPS (needed for pairing)

The phone only pairs with an **`https://`** address, because the connection carries the phone's
credential and must be encrypted. The server listens only on `127.0.0.1:8787`, so a web server in front
of it must provide HTTPS. **This guide does not assume you already have a domain.** You need one of:

| Option | What you need | Notes |
| --- | --- | --- |
| **A. Your own domain + Caddy** (recommended) | A domain or subdomain (for example `tb.yourname.in`) with an **A record** pointing at the EC2 instance's **Elastic IP** | Caddy gets a free Let's Encrypt certificate and renews it by itself. A domain usually costs a little per year. |
| **B. A free dynamic-DNS name + Caddy** | A free subdomain from a dynamic-DNS service, pointed at the Elastic IP | Same as A, without buying a domain. You depend on that service staying up. |
| **C. A private network (Tailscale)** | The free personal Tailscale plan on the server and the phone; `tailscale serve` gives an `https://…ts.net` address | Nothing is opened to the internet, but the phone must be connected to Tailscale to pair and check status. Pushes themselves come through Google either way. |

For A or B:

1. Give the EC2 instance an **Elastic IP** (EC2 → Elastic IPs → Allocate → Associate), so the address
   never changes.
2. Point your DNS name at it (an **A record**).
3. In the EC2 **security group**, allow inbound **443** and **80** (80 is only for the certificate check).
   Never open 8787.
4. Install Caddy and use [server/deploy/Caddyfile.example](../server/deploy/Caddyfile.example). Replace
   `tradebuddy.example.com` with your name, then run `sudo systemctl reload caddy`.
5. Check from your phone's browser or your computer: `https://YOUR-NAME/healthz` should answer
   `{"status":"ok",…}`.

## Step 7 — Pair your phone

1. On the server, make a **one-time pairing code**. It works once, for 10 minutes. The admin token stays
   on the server:

   ```bash
   TOKEN=$(sudo sed -n 's/^TB_API_TOKEN=//p' /etc/tradebuddy/server.env)
   curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/pairing-code
   ```

   It answers with a code like `K7QX2-M9PRT`.
2. On the phone (an APK built with `google-services.json`): **Settings** (Me → More → Settings) → the
   **Cloud alerts** card, just below Alerts.
3. Enter the server address (for example `https://tb.yourname.in`), the code, and a name for the phone.
4. Tap **Pair this phone**. Allow notifications when Android asks.
5. The card should say **✅ On**. On the server, check the phone:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices
   ```

   `tokenState` should be `"active"`. The token itself is never shown, only its last 6 characters.

What pairing creates: a credential for this phone only, kept on the phone encrypted with a key in the
Android Keystore (not in the app's ordinary storage; the app's data is also excluded from Android backups).
The server keeps only its fingerprint (hash). The admin `TB_API_TOKEN`, the Upstox tokens and the Firebase
key are **never** in the app. Five wrong codes from one address within 15 minutes block pairing from that
address for a while.

## Step 8 — Send a safe test notification

In the app: **Settings → Cloud alerts → Send a test push.** Or from the server (`<id>` comes from
`/v1/devices`):

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/<id>/test-push
```

It sends "🔔 TradeBuddy test notification — Your server can reach this phone. Nothing was bought or sold."
It never touches Upstox. `GET /v1/push` shows how many pushes were sent or failed and the last error.

## Step 9 — Check it works with the app closed

1. Open the recent-apps screen and **swipe TradeBuddy away**. Don't use Android's **Force stop**: a
   force-stopped app gets no pushes until you open it again.
2. Lock the phone.
3. Send a test push from the server (the `curl` in step 8).
4. Within about a minute a notification should appear. **Tap it**. The app opens on the alert's details.

If nothing arrives:

* Android settings → Apps → TradeBuddy → **Notifications: allowed**.
* Xiaomi, Realme, Oppo, Vivo, Samsung: also allow **Autostart** / **No battery restrictions** for
  TradeBuddy. These phones may hold back pushes for apps they consider "sleeping".
* Settings → Cloud alerts → **Check connection** shows what the server knows (token state, sent/failed).
* On the server: `journalctl -u tradebuddy-server -f` and `GET /v1/push` (`lastError`).

## Step 10 — Unpair or revoke a phone

* **From the phone:** Settings → Cloud alerts → **Unpair**. The server forgets the phone, Firebase deletes
  its token, and the phone's credential is erased. The phone then alerts by itself again, as before.
* **Lost phone, or the phone can't reach the server:** revoke it on the server. Its credential stops
  working at once and nothing more is sent to it.

  ```bash
  curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices            # find its id
  curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/<id>
  ```

* **Replace the Firebase key** (for example, if it may have leaked): Google Cloud Console → IAM & Admin →
  Service accounts → your account → **Keys** → delete the old key, add a new one. Then repeat step 5 and
  restart the server.

---

## How it fits together

```
 server scan finds a signal ──► notify() ──► alert history (24-hour de-duplication by alert id)
                                   │
                                   └──► push outbox in SQLite (one row per alert and phone, never twice)
                                            │ every 2 s, separate from the scans
                                            ▼
                                Google OAuth (service-account JWT) ──► FCM HTTP v1 ──► your phone
                                   retry 5 s, 10 s, 20 s … 30 min (8 tries) on temporary errors;
                                   an invalid or expired token stops pushes to that phone until it
                                   sends a new one (the app does that each time it starts)
```

**No duplicates between the phone and the server — and no gaps when the server stops.** Both run the
same code, so the same signal has the same alert id on both. While the app runs it asks the server every
3 minutes (one small request) whether it is making signals, its pushes work and this phone's token is
active. Only while the server says yes (within the last 7 minutes) does the phone leave the market signals
the server pushes (rising, falling, breakouts, day-trade, intraday, Early Movers, top picks) to the server:
it then keeps them in the Alerts tab and shows the banner when the app is open, without a second pop-up.
If the server is down, unreachable, or not making signals (e.g. its Upstox token expired), the phone's
own pop-ups come back by themselves. A push for an alert the phone already has is not shown again.
Practice money, price alerts (stop-loss / target), plans and the auto-trader are about the phone's own
data, so they always alert from the phone. The server never pushes the phone-only messages (Upstox
login reminder, evening scan summary). A market signal the server could not deliver within 30 minutes
(e.g. it was down) is dropped, not delivered late.

**Battery:** the app runs no background work of its own for this when it is closed — Android's Google
Play services receive the pushes. While it runs, it checks its push token at start and asks the server
every 3 minutes.
