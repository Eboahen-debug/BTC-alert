# ₿ BTC Alert Server

Monitors Bitcoin price every 60 seconds and sends a **push notification to your phone** every time BTC moves **$500** in either direction. Also alerts on key level breaches ($79K, $82K, $75.6K, etc).

---

## 📱 How Notifications Work

Uses **ntfy.sh** — free, no account needed, works on iOS & Android.

1. Install the ntfy app: [iOS](https://apps.apple.com/app/ntfy/id1625396347) | [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Subscribe to your topic (see your server dashboard for the topic name)
3. Done — alerts arrive instantly on your phone

---

## 🚀 Deploy to Render.com (Free, 5 minutes)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "BTC alert server"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/btc-alert-server.git
git push -u origin main
```

### Step 2 — Deploy on Render
1. Go to [render.com](https://render.com) → Sign up free
2. Click **New +** → **Web Service**
3. Connect your GitHub repo
4. Render auto-detects the config from `render.yaml`
5. Click **Deploy** — live in ~2 minutes

### Step 3 — Set your ntfy topic
In Render dashboard → Environment:
- `NTFY_TOPIC` = something unique like `btc-alert-yourname-2026`
  (This is your private channel — make it hard to guess)

### Step 4 — Subscribe on your phone
Open ntfy app → **+** → type your topic name → Subscribe

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NTFY_TOPIC` | `btc-price-alert-9x7k2m` | Your ntfy channel name (make it unique!) |
| `ALERT_DELTA` | `500` | USD move that triggers a notification |
| `POLL_SECONDS` | `60` | How often to check the price |

---

## 📊 Dashboard

Visit your Render URL in a browser to see:
- Live BTC price
- Recent price history
- How many alerts sent
- Key levels with distance
- ntfy setup instructions

The page auto-refreshes every 30 seconds.

---

## 🔔 Alert Types

| Alert | Trigger | Priority |
|-------|---------|----------|
| 🟢 BTC UP $500 | Price rises $500 from last alert | Normal |
| 🔴 BTC DOWN $500 | Price drops $500 from last alert | Normal |
| 🟢/🔴 BTC UP/DOWN $1000+ | $1000+ single move | **High** |
| 🚨 Resistance Broken | Price crosses $79K, $82K, $84.5K | **High** |
| 🔴 Support Broken | Price crosses below $75.6K, $74.3K, $70K | **High** |

---

## 🏗️ Price Sources (automatic failover)
1. **Binance** (primary)
2. **Kraken** (backup)
3. **CoinCap** (backup)

---

## Local Development
```bash
npm install
NTFY_TOPIC=my-test-topic node server.js
```
Then open http://localhost:3000
