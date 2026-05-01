const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIG ────────────────────────────────────────────────────────
// Your ntfy topic — change this to something unique e.g. "btc-alert-james-2026"
// Anyone who knows this topic name can subscribe, so make it hard to guess
const NTFY_TOPIC   = process.env.NTFY_TOPIC   || "btc-price-alert-9x7k2m";
const ALERT_DELTA  = parseInt(process.env.ALERT_DELTA  || "20");   // $20 move triggers alert
const POLL_SECONDS = parseInt(process.env.POLL_SECONDS || "60");     // check every 60s

// Key levels for contextual alerts
const RESISTANCE = [79000, 82228, 84543];
const SUPPORT    = [75650, 74300, 70027];

// ── STATE ─────────────────────────────────────────────────────────
let lastAlertPrice  = null;   // price at which we last sent a $500 alert
let lastPrice       = null;   // most recent fetched price
let lastFetchTime   = null;
let priceHistory    = [];     // last 100 readings
let alertsSent      = 0;
let fetchErrors     = 0;
let serverStartTime = new Date();

// ── FETCH PRICE ───────────────────────────────────────────────────
async function fetchPrice() {
  const sources = [
    // Binance — very reliable, open CORS
    async () => {
      const r = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT", { timeout: 8000 });
      if (!r.ok) throw new Error("binance " + r.status);
      const d = await r.json();
      return {
        price:     parseFloat(d.lastPrice),
        change24h: parseFloat(d.priceChangePercent),
        high24h:   parseFloat(d.highPrice),
        low24h:    parseFloat(d.lowPrice),
        volume24h: parseFloat(d.quoteVolume),
        source:    "Binance",
      };
    },
    // Kraken — independent backup
    async () => {
      const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", { timeout: 8000 });
      if (!r.ok) throw new Error("kraken " + r.status);
      const d = await r.json();
      const t = d.result.XXBTZUSD;
      return {
        price:     parseFloat(t.c[0]),
        change24h: null,
        high24h:   parseFloat(t.h[1]),
        low24h:    parseFloat(t.l[1]),
        volume24h: parseFloat(t.v[1]),
        source:    "Kraken",
      };
    },
    // CoinCap — third fallback
    async () => {
      const r = await fetch("https://api.coincap.io/v2/assets/bitcoin", { timeout: 8000 });
      if (!r.ok) throw new Error("coincap " + r.status);
      const { data: d } = await r.json();
      return {
        price:     parseFloat(d.priceUsd),
        change24h: parseFloat(d.changePercent24Hr),
        high24h:   null,
        low24h:    null,
        volume24h: parseFloat(d.volumeUsd24Hr),
        source:    "CoinCap",
      };
    },
  ];

  for (const fn of sources) {
    try {
      const data = await fn();
      if (!data.price || isNaN(data.price)) throw new Error("bad price");
      return data;
    } catch (e) {
      // try next source
    }
  }
  throw new Error("All price sources failed");
}

// ── SEND NTFY PUSH NOTIFICATION ───────────────────────────────────
async function sendPush(title, message, tags = [], priority = "default") {
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method:  "POST",
      headers: {
        "Title":    title,
        "Tags":     tags.join(","),
        "Priority": priority,
        "Content-Type": "text/plain",
      },
      body: message,
      timeout: 10000,
    });
    if (res.ok) {
      alertsSent++;
      console.log(`[PUSH SENT] ${title} — ${message}`);
    } else {
      console.error(`[PUSH FAILED] HTTP ${res.status}`);
    }
  } catch (e) {
    console.error("[PUSH ERROR]", e.message);
  }
}

// ── LEVEL CHECK ───────────────────────────────────────────────────
function getLevelAlert(price, prevPrice) {
  if (!prevPrice) return null;
  for (const lvl of RESISTANCE) {
    if (prevPrice < lvl && price >= lvl)
      return { msg: `🚨 BTC broke ABOVE resistance $${lvl.toLocaleString()}!`, priority: "high", tags: ["rotating_light", "chart_increasing"] };
    if (prevPrice > lvl && price <= lvl)
      return { msg: `⬇️ BTC fell back below $${lvl.toLocaleString()} resistance`, priority: "default", tags: ["warning"] };
  }
  for (const lvl of SUPPORT) {
    if (prevPrice > lvl && price <= lvl)
      return { msg: `🔴 BTC broke BELOW support $${lvl.toLocaleString()}!`, priority: "high", tags: ["rotating_light", "chart_decreasing"] };
    if (prevPrice < lvl && price >= lvl)
      return { msg: `✅ BTC reclaimed $${lvl.toLocaleString()} support`, priority: "default", tags: ["white_check_mark"] };
  }
  return null;
}

// ── MAIN POLL LOOP ────────────────────────────────────────────────
async function poll() {
  try {
    const data = await fetchPrice();
    const prev = lastPrice;
    lastPrice      = data.price;
    lastFetchTime  = new Date();
    fetchErrors    = 0;

    priceHistory.push({ price: data.price, time: lastFetchTime.toISOString(), source: data.source });
    if (priceHistory.length > 100) priceHistory.shift();

    console.log(`[${lastFetchTime.toISOString()}] BTC $${data.price.toFixed(0)} (${data.source})`);

    // ── $500 MOVE ALERT ──
    if (lastAlertPrice === null) {
      lastAlertPrice = data.price;
      // Send startup notification
      await sendPush(
        "₿ BTC Alert Server Started",
        `Monitoring BTC price. Current: $${Math.round(data.price).toLocaleString()}\nYou'll get alerts every $${ALERT_DELTA} move.\nTopic: ${NTFY_TOPIC}`,
        ["bitcoin", "bell"],
        "default"
      );
    } else {
      const delta = data.price - lastAlertPrice;
      if (Math.abs(delta) >= ALERT_DELTA) {
        const dir     = delta > 0 ? "UP" : "DOWN";
        const emoji   = delta > 0 ? "🟢" : "🔴";
        const arrow   = delta > 0 ? "▲" : "▼";
        const pct     = ((delta / lastAlertPrice) * 100).toFixed(2);
        const c24     = data.change24h != null ? ` | 24H: ${data.change24h >= 0 ? "+" : ""}${data.change24h.toFixed(2)}%` : "";

        await sendPush(
          `${emoji} BTC ${dir} $${Math.abs(Math.round(delta)).toLocaleString()}`,
          `${arrow} $${Math.round(data.price).toLocaleString()} (${delta >= 0 ? "+" : ""}${pct}%)\nFrom: $${Math.round(lastAlertPrice).toLocaleString()} → $${Math.round(data.price).toLocaleString()}${c24}\nH: $${data.high24h ? Math.round(data.high24h).toLocaleString() : "—"} | L: $${data.low24h ? Math.round(data.low24h).toLocaleString() : "—"}`,
          delta > 0 ? ["chart_increasing", "moneybag"] : ["chart_decreasing", "rotating_light"],
          Math.abs(delta) >= 1000 ? "high" : "default"
        );
        lastAlertPrice = data.price;
      }
    }

    // ── KEY LEVEL BREACH ALERT ──
    const levelAlert = getLevelAlert(data.price, prev);
    if (levelAlert) {
      await sendPush(
        `₿ BTC Level Alert`,
        `${levelAlert.msg}\nCurrent: $${Math.round(data.price).toLocaleString()}`,
        levelAlert.tags,
        levelAlert.priority
      );
    }

  } catch (e) {
    fetchErrors++;
    console.error(`[POLL ERROR #${fetchErrors}]`, e.message);
    if (fetchErrors === 5) {
      await sendPush("⚠️ BTC Alert: Fetch Errors", `Failed to get price 5 times in a row. Check server.`, ["warning"], "high");
    }
  }
}

// ── HTTP DASHBOARD ────────────────────────────────────────────────
app.get("/", (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
  const uptimeStr = `${h}h ${m}m ${s}s`;
  const recent = priceHistory.slice(-10).reverse();

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>BTC Alert Server</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#050a0e;color:#cce0ea;font-family:'Courier New',monospace;padding:20px;font-size:13px}
  h1{color:#f7931a;letter-spacing:4px;font-size:18px;margin-bottom:4px}
  .sub{color:#2a5060;font-size:9px;letter-spacing:3px;margin-bottom:20px}
  .card{background:#0a1520;border:1px solid #0e2a3a;border-left:3px solid #f7931a;padding:14px 16px;margin-bottom:12px;border-radius:2px}
  .card h2{font-size:9px;letter-spacing:3px;color:#2a6070;margin-bottom:8px}
  .price{font-size:36px;font-weight:900;color:#f7931a;text-shadow:0 0 20px rgba(247,147,26,.4)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .stat{background:#060f18;padding:10px;border-left:2px solid #0e2a3a}
  .stat-l{font-size:7px;letter-spacing:2px;color:#1e4050;margin-bottom:4px}
  .stat-v{font-size:13px;font-weight:700;color:#8ab4c0}
  .green{color:#00cc66}.red{color:#ee3333}.cyan{color:#00d4ff}
  .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #091820;font-size:11px}
  .row:last-child{border:none}
  .ntfy{background:#0a1f0a;border-color:#00aa44;border-left-color:#00ff88}
  .ntfy h2{color:#00aa44}
  .ntfy-topic{font-size:14px;color:#00ff88;word-break:break-all;margin:4px 0 8px}
  .step{display:flex;gap:10px;margin-bottom:8px;align-items:flex-start}
  .num{background:#00ff88;color:#050a0e;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:10px;flex-shrink:0;margin-top:1px}
  .step-text{font-size:11px;color:#5a9a6a;line-height:1.5}
  a{color:#00ff88}
  .badge{display:inline-block;padding:2px 8px;font-size:8px;letter-spacing:1px;border-radius:2px;margin-right:4px}
  .badge-g{background:rgba(0,255,136,.15);color:#00ff88;border:1px solid rgba(0,255,136,.3)}
  .badge-o{background:rgba(247,147,26,.15);color:#f7931a;border:1px solid rgba(247,147,26,.3)}
</style>
</head>
<body>
<h1>₿ BTC ALERT SERVER</h1>
<div class="sub">LIVE PRICE MONITOR · AUTO-REFRESH 30s</div>

<div class="card">
  <h2>CURRENT PRICE</h2>
  <div class="price">${lastPrice ? "$" + Math.round(lastPrice).toLocaleString() : "LOADING..."}</div>
  <div style="margin-top:6px;font-size:9px;color:#2a5060">
    Last fetch: ${lastFetchTime ? lastFetchTime.toUTCString() : "—"} &nbsp;|&nbsp;
    Source: ${priceHistory.length ? priceHistory[priceHistory.length-1].source : "—"}
  </div>
</div>

<div class="grid" style="margin-bottom:12px">
  <div class="stat"><div class="stat-l">ALERTS SENT</div><div class="stat-v cyan">${alertsSent}</div></div>
  <div class="stat"><div class="stat-l">TRIGGER DELTA</div><div class="stat-v">$${ALERT_DELTA}</div></div>
  <div class="stat"><div class="stat-l">LAST ALERT PRICE</div><div class="stat-v">${lastAlertPrice ? "$"+Math.round(lastAlertPrice).toLocaleString() : "—"}</div></div>
  <div class="stat"><div class="stat-l">UPTIME</div><div class="stat-v green">${uptimeStr}</div></div>
  <div class="stat"><div class="stat-l">READINGS TAKEN</div><div class="stat-v">${priceHistory.length}</div></div>
  <div class="stat"><div class="stat-l">FETCH ERRORS</div><div class="stat-v ${fetchErrors > 0 ? "red" : "green"}">${fetchErrors}</div></div>
</div>

<div class="card ntfy">
  <h2>📱 PUSH NOTIFICATIONS · ntfy.sh</h2>
  <div class="ntfy-topic">${NTFY_TOPIC}</div>
  <div class="step"><div class="num">1</div><div class="step-text">Install the <strong>ntfy</strong> app on your phone:<br><a href="https://apps.apple.com/app/ntfy/id1625396347">iOS App Store</a> &nbsp;|&nbsp; <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Google Play</a></div></div>
  <div class="step"><div class="num">2</div><div class="step-text">Open ntfy → tap <strong>+</strong> → Subscribe to topic:<br><strong style="color:#00ff88">${NTFY_TOPIC}</strong></div></div>
  <div class="step"><div class="num">3</div><div class="step-text">Done! You'll get push alerts every time BTC moves <strong>$${ALERT_DELTA}</strong> + level breaches</div></div>
</div>

<div class="card">
  <h2>ALERT TRIGGERS</h2>
  <div style="margin-bottom:8px">
    <span class="badge badge-o">$${ALERT_DELTA} MOVE</span>
    <span class="badge badge-g">LEVEL BREACH</span>
    <span class="badge badge-o">HIGH PRIORITY &gt;$1000</span>
  </div>
  <div style="font-size:9px;color:#1e3a4a;margin-bottom:10px">KEY LEVELS WATCHED</div>
  ${[...RESISTANCE.map(l=>`<div class="row"><span style="color:#cc3333">R: $${l.toLocaleString()}</span><span style="color:#444">${lastPrice ? (lastPrice < l ? "▲ +" + (l-lastPrice).toFixed(0) + " away" : "✓ above") : "—"}</span></div>`),
     ...SUPPORT.map(l=>`<div class="row"><span style="color:#009944">S: $${l.toLocaleString()}</span><span style="color:#444">${lastPrice ? (lastPrice > l ? "▼ -" + (lastPrice-l).toFixed(0) + " away" : "✓ below") : "—"}</span></div>`)].join("")}
</div>

<div class="card">
  <h2>RECENT PRICE HISTORY (LAST 10)</h2>
  ${recent.length === 0 ? '<div style="color:#1e3a4a;font-size:10px">No data yet</div>' :
    recent.map((r, i) => {
      const prev = recent[i+1];
      const delta = prev ? r.price - prev.price : 0;
      const col = delta > 0 ? "#00cc66" : delta < 0 ? "#ee3333" : "#4a7a88";
      return `<div class="row">
        <span style="color:#1e3a4a">${new Date(r.time).toTimeString().slice(0,8)}</span>
        <span style="color:#cce0ea;font-weight:700">$${Math.round(r.price).toLocaleString()}</span>
        <span style="color:${col}">${delta !== 0 ? (delta > 0 ? "▲" : "▼") + "$" + Math.abs(Math.round(delta)) : "—"}</span>
        <span style="color:#1e3a4a;font-size:9px">${r.source}</span>
      </div>`;
    }).join("")}
</div>

<div style="font-size:7px;color:#0e2a38;letter-spacing:2px;margin-top:10px;text-align:center">
  POLL INTERVAL: ${POLL_SECONDS}s · NOT FINANCIAL ADVICE
</div>
</body>
</html>`);
});

// Health check for Render.com
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    price: lastPrice,
    lastFetch: lastFetchTime,
    alertsSent,
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
  });
});

// Manual price check endpoint
app.get("/price", async (req, res) => {
  try {
    const data = await fetchPrice();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟠 BTC Alert Server running on port ${PORT}`);
  console.log(`📱 Push topic: ${NTFY_TOPIC}`);
  console.log(`💰 Alert every: $${ALERT_DELTA} move`);
  console.log(`⏱  Poll every: ${POLL_SECONDS}s\n`);
});

// Start polling immediately, then on interval
poll();
setInterval(poll, POLL_SECONDS * 1000);

// Keep-alive ping to prevent Render free tier sleep (pings self every 14 min)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(async () => {
    try {
      await fetch(`${process.env.RENDER_EXTERNAL_URL}/health`, { timeout: 10000 });
      console.log("[KEEPALIVE] pinged self");
    } catch (e) {}
  }, 14 * 60 * 1000);
}
