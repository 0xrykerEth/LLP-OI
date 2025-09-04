const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const APP_PORT = process.env.PORT || 3000;
const LLM_ACCOUNT_API = 'https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=281474976710654';
const WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';

function sumPositionValuesFromApiResponse(apiResponseJson) {
    if (!apiResponseJson || !apiResponseJson.accounts || !Array.isArray(apiResponseJson.accounts)) {
        return { total: 0, count: 0, openInterest: 0 };
    }

    const account = apiResponseJson.accounts[0];
    const positions = Array.isArray(account?.positions) ? account.positions : [];

    let total = 0;
    let count = 0;
    let openInterest = 0;

    for (const position of positions) {
        const valueRaw = position?.position_value;
        const value = typeof valueRaw === 'string' ? Number(valueRaw) : (typeof valueRaw === 'number' ? valueRaw : 0);
        if (Number.isFinite(value)) {
            total += value;
            count += 1;
            openInterest += Math.abs(value);
        }
    }

    return { total, count, openInterest };
}

const app = express();

// Exchange-wide OI aggregator via WebSocket
const marketIndexToOi = new Map();
let lastExchangeOiUpdate = 0;
let wsConnected = false;
const wsSamples = [];

function getExchangeOiTotal() {
    let total = 0;
    for (const value of marketIndexToOi.values()) {
        if (Number.isFinite(value)) total += Math.abs(value);
    }
    return total;
}

function startExchangeOiWs() {
    let ws;
    let heartbeat;

    const connect = () => {
        ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            wsConnected = true;
            // Subscribe to market stats for all markets (public channel)
            // Reference: WebSocket docs [market stats channel]
            // https://apibetadocs.lighter.xyz/docs/websocket-reference
            try {
                ws.send(JSON.stringify({ type: 'subscribe', channel: 'market_stats' }));
                // Also try per-market subscriptions in case the server expects an index
                for (let i = 0; i <= 100; i++) {
                    try { ws.send(JSON.stringify({ type: 'subscribe', channel: `market_stats/${i}` })); } catch {}
                }
            } catch {}

            // heartbeat
            clearInterval(heartbeat);
            heartbeat = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try { ws.ping(); } catch {}
                }
            }, 15000);
        });

        ws.on('message', (message) => {
            try {
                const parsed = JSON.parse(message.toString());
                // keep a small ring buffer of sample messages for debugging
                try {
                    wsSamples.push({ ts: Date.now(), sample: JSON.stringify(parsed).slice(0, 500) });
                    if (wsSamples.length > 6) wsSamples.shift();
                } catch {}
                // Accept both snapshot and incremental updates
                // Try common shapes: { stats: { [market]: { open_interest } } } or array of stats
                if (parsed && typeof parsed === 'object') {
                    const tryExtractOi = (obj) => {
                        // Accept keys: open_interest, openInterest, oi
                        if (!obj || typeof obj !== 'object') return undefined;
                        const v = obj.open_interest ?? obj.openInterest ?? obj.oi;
                        const num = typeof v === 'string' ? Number(v) : (typeof v === 'number' ? v : undefined);
                        return Number.isFinite(num) ? num : undefined;
                    };

                    const upsertMarket = (marketIdLike, oiVal) => {
                        const key = String(marketIdLike ?? 'unknown');
                        if (Number.isFinite(oiVal)) {
                            marketIndexToOi.set(key, oiVal);
                            lastExchangeOiUpdate = Date.now();
                        }
                    };

                    if (Array.isArray(parsed)) {
                        parsed.forEach((item) => {
                            const oi = tryExtractOi(item);
                            const mid = item?.market_id ?? item?.marketIndex ?? item?.market;
                            if (oi !== undefined && mid !== undefined) upsertMarket(mid, oi);
                        });
                    } else if (parsed.stats && typeof parsed.stats === 'object') {
                        // stats keyed by market index
                        Object.keys(parsed.stats).forEach((k) => {
                            const oi = tryExtractOi(parsed.stats[k]);
                            if (oi !== undefined) upsertMarket(k, oi);
                        });
                    } else if (parsed.market_stats && Array.isArray(parsed.market_stats)) {
                        parsed.market_stats.forEach((s) => {
                            const oi = tryExtractOi(s);
                            const mid = s?.market_id ?? s?.marketIndex ?? s?.market;
                            if (oi !== undefined && mid !== undefined) upsertMarket(mid, oi);
                        });
                    } else if (parsed.type && typeof parsed.type === 'string' && parsed.type.includes('market_stats')) {
                        // updates like { type: 'update/market_stats', market_id, open_interest }
                        const oi = tryExtractOi(parsed);
                        const mid = parsed?.market_id ?? parsed?.marketIndex ?? parsed?.market;
                        if (oi !== undefined && mid !== undefined) upsertMarket(mid, oi);
                    } else if (parsed.channel && typeof parsed.channel === 'string' && parsed.channel.startsWith('market_stats')) {
                        // messages with explicit channel and payload in data or body
                        const payload = parsed.data ?? parsed.body ?? parsed;
                        const oi = tryExtractOi(payload);
                        const mid = payload?.market_id ?? payload?.marketIndex ?? payload?.market;
                        if (oi !== undefined && mid !== undefined) upsertMarket(mid, oi);
                    }
                }
            } catch (e) {
                // swallow
            }
        });

        ws.on('close', () => {
            wsConnected = false;
            clearInterval(heartbeat);
            setTimeout(connect, 2000);
        });

        ws.on('error', () => {
            try { ws.close(); } catch {}
        });
    };

    connect();
}

startExchangeOiWs();

app.get('/api/llp-total', async (req, res) => {
    try {
        const { data } = await axios.get(LLM_ACCOUNT_API, { timeout: 15000 });
        const { total, count, openInterest } = sumPositionValuesFromApiResponse(data);
        res.json({ total, count, open_interest: openInterest, source: 'LLP', account_index: 281474976710654 });
    } catch (error) {
        res.status(502).json({ error: 'Failed to fetch upstream data' });
    }
});

app.get('/api/exchange-oi', (req, res) => {
    const total = getExchangeOiTotal();
    res.json({ total_open_interest: total, markets: marketIndexToOi.size, last_updated_ms: lastExchangeOiUpdate });
});

app.get('/api/ws-debug', (req, res) => {
    res.json({
        ws_connected: wsConnected,
        markets_tracked: marketIndexToOi.size,
        last_updated_ms: lastExchangeOiUpdate,
        sample_messages: wsSamples
    });
});

app.get('/', async (req, res) => {
    try {
        const { data } = await axios.get(LLM_ACCOUNT_API, { timeout: 15000 });
        const { total, count } = sumPositionValuesFromApiResponse(data);
        const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(total);
        res.type('html').send(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TOTAL LLP Position</title>
    <style>
      :root {
        --bg-from: #0f172a; /* slate-900 */
        --bg-to: #1e293b;   /* slate-800 */
        --card-bg: #111827; /* gray-900 */
        --card-border: #374151; /* gray-700 */
        --text: #f9fafb; /* gray-50 */
        --muted: #94a3b8; /* slate-400 */
        --accent: #22c55e; /* green-500 */
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        color: var(--text);
        background: radial-gradient(1200px 800px at 10% 10%, #0b1220 0%, transparent 60%),
                    radial-gradient(1000px 700px at 90% 20%, #0a1b2e 0%, transparent 60%),
                    linear-gradient(180deg, var(--bg-from), var(--bg-to));
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 860px;
        background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
        border: 1px solid var(--card-border);
        border-radius: 16px;
        padding: 28px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04);
        backdrop-filter: blur(6px);
      }
      .row { display: grid; grid-template-columns: 1fr; gap: 16px; }
      @media (min-width: 720px) { .row { grid-template-columns: 1fr auto; align-items: end; } }
      h1 { margin: 0; font-size: 28px; letter-spacing: 0.2px; font-weight: 650; }
      .muted { color: var(--muted); font-size: 14px; margin-top: 8px; }
      .pill {
        display: inline-flex; align-items: center; gap: 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 6px 10px; border-radius: 999px; font-size: 12px; color: var(--muted);
      }
      .value {
        font-size: 48px; font-weight: 800; letter-spacing: 0.3px;
        background: linear-gradient(90deg, #e2e8f0, #a7f3d0);
        -webkit-background-clip: text; background-clip: text; color: transparent;
        text-shadow: 0 1px 0 rgba(255,255,255,0.1);
      }
      .value.sm { font-size: 24px; font-weight: 700; }
      .footer { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
      code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); }
      .badge { color: #10b981; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.2); padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
      .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .refresh { color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <div class="pill">LLP Account <code>281474976710654</code></div>
        <div class="refresh" id="refreshInfo">Live</div>
      </div>
      <div class="row">
        <div>
          <h1>TOTAL LLP Position</h1>
          <div class="value" id="totalValue">$${formatted}</div>
          <div class="footer">
            <span class="pill">Positions counted: <strong id="posCount">${count}</strong></span>
            <span class="pill">Source: <code>mainnet.zklighter.elliot.ai</code></span>
            <span class="badge">Auto-refreshing</span>
          </div>
        </div>
      </div>
    </div>
    <script>
      const formatUsd = (num) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
      const totalEl = document.getElementById('totalValue');
      const countEl = document.getElementById('posCount');
      const refreshEl = document.getElementById('refreshInfo');
      let current = ${total};

      function animateTo(target, durationMs = 800) {
        const start = current;
        const delta = target - start;
        const startTs = performance.now();
        function step(now) {
          const t = Math.min(1, (now - startTs) / durationMs);
          const ease = 1 - Math.pow(1 - t, 3);
          const val = start + delta * ease;
          totalEl.textContent = '$' + formatUsd(val);
          if (t < 1) requestAnimationFrame(step); else current = target;
        }
        requestAnimationFrame(step);
      }

      async function refresh() {
        try {
          refreshEl.textContent = 'Refreshing...';
          const res = await fetch('/api/llp-total', { cache: 'no-store' });
          const json = await res.json();
          if (typeof json.total === 'number') {
            animateTo(json.total);
            countEl.textContent = json.count;
            refreshEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
          } else {
            refreshEl.textContent = 'No data';
          }
        } catch (e) {
          refreshEl.textContent = 'Fetch failed';
        }
      }

      setInterval(refresh, 30000);
      // immediate refresh on load
      refresh();
    </script>
  </body>
 </html>
        `.trim());
    } catch (error) {
        res.status(502).type('html').send('<h1>Upstream fetch failed</h1>');
    }
});

app.listen(APP_PORT, () => {
    console.log(`Server listening on http://localhost:${APP_PORT}`);
});

module.exports = { sumPositionValuesFromApiResponse };


