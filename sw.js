// ============================================================
// SERVICE WORKER — Binance TH Spot Signal
// วางไฟล์นี้ที่ root ของเว็บ เช่น https://yoursite.com/sw.js
// ============================================================

const CACHE = 'bth-spot-v1';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 ชั่วโมง
const API = 'https://api.binance.com/api/v3';

// ─── Install & Activate ───
self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
  scheduleCheck();
});

// ─── Message from main page ───
self.addEventListener('message', e => {
  if (e.data === 'START_SCHEDULE') scheduleCheck();
  if (e.data === 'CHECK_NOW') runSignalCheck();
});

// ─── Schedule every 4 hours ───
let timer = null;
function scheduleCheck() {
  if (timer) clearInterval(timer);
  runSignalCheck(); // ตรวจทันทีตอนเปิด
  timer = setInterval(runSignalCheck, CHECK_INTERVAL);
}

// ─── Indicator helpers ───
function calcEMA(data, p) {
  const k = 2 / (p + 1);
  let ema = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const r = new Array(p - 1).fill(null);
  r.push(ema);
  for (let i = p; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    r.push(ema);
  }
  return r;
}
function calcRSI(data, p = 14) {
  const r = new Array(p).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = data[i] - data[i - 1];
    d > 0 ? g += d : l -= d;
  }
  let ag = g / p, al = l / p;
  r.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = p + 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    r.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return r;
}
function calcMACD(data) {
  const e12 = calcEMA(data, 12), e26 = calcEMA(data, 26);
  const macd = e12.map((v, i) => (v && e26[i]) ? v - e26[i] : null);
  const valid = macd.filter(v => v !== null);
  const sig = calcEMA(valid, 9);
  const offset = macd.filter(v => v === null).length;
  const signal = new Array(offset + valid.length - sig.length).fill(null).concat(sig);
  return { macd, signal };
}
function calcBB(data, p = 20, m = 2) {
  return data.map((_, i) => {
    if (i < p - 1) return null;
    const sl = data.slice(i - p + 1, i + 1);
    const mean = sl.reduce((a, b) => a + b, 0) / p;
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
    return { mid: mean, upper: mean + m * std, lower: mean - m * std };
  });
}
function getScore(closes) {
  const last = closes[closes.length - 1];
  const rsiA = calcRSI(closes); const rsi = rsiA[rsiA.length - 1];
  const e20 = calcEMA(closes, 20); const e50 = calcEMA(closes, 50);
  const { macd, signal } = calcMACD(closes);
  const bb = calcBB(closes); const bbl = bb[bb.length - 1];
  const macdV = macd[macd.length - 1]; const sigV = signal[signal.length - 1];
  const macdPrev = macd[macd.length - 2];
  let s = 5;
  if (rsi < 30) s += 2; else if (rsi < 45) s += 1; else if (rsi > 70) s -= 2; else if (rsi > 60) s -= 1;
  if (last > e20[e20.length - 1]) s++; else s--;
  if (last > e50[e50.length - 1]) s++; else s--;
  if (macdV > sigV) s++; else s--;
  if (macdV > (macdPrev || 0)) s += 0.5; else s -= 0.5;
  if (bbl && last < bbl.lower) s++; else if (bbl && last > bbl.upper) s--;
  return { score: Math.max(0, Math.min(10, Math.round(s))), rsi, last };
}

// ─── Main Check Function ───
async function runSignalCheck() {
  const COINS = [
    'BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','SOLUSDT',
    'ADAUSDT','DOGEUSDT','DOTUSDT','MATICUSDT','LINKUSDT',
    'LTCUSDT','AVAXUSDT','UNIUSDT','ATOMUSDT','TRXUSDT',
    'NEARUSDT','SANDUSDT','AXSUSDT','SHIBUSDT','FTMUSDT',
    'ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','APTUSDT'
  ];
  const THB = 33.5;
  const buySignals = [], sellSignals = [];

  await Promise.all(COINS.map(async sym => {
    try {
      const klines = await fetch(`${API}/klines?symbol=${sym}&interval=4h&limit=100`).then(r => r.json());
      const closes = klines.map(k => parseFloat(k[4]));
      const { score, rsi, last } = getScore(closes);
      const label = sym.replace('USDT', '');
      const thbPrice = (last * THB).toLocaleString('th-TH', { maximumFractionDigits: 0 });

      if (score >= 7) {
        buySignals.push({ label, score, rsi: rsi.toFixed(0), price: thbPrice });
      } else if (score <= 3) {
        sellSignals.push({ label, score, rsi: rsi.toFixed(0), price: thbPrice });
      }
    } catch (e) { /* skip */ }
  }));

  const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  // ─── BUY Notification ───
  if (buySignals.length > 0) {
    const top = buySignals.sort((a, b) => b.score - a.score).slice(0, 5);
    const body = top.map(c => `🟢 ${c.label}  ฿${c.price}  RSI:${c.rsi}  Score:${c.score}/10`).join('\n');
    await self.registration.showNotification('📈 จังหวะซื้อ — Binance TH', {
      body: `${top.length} เหรียญมีสัญญาณ BUY เวลา ${now}\n\n${body}`,
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      tag: 'buy-signal',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { type: 'buy', coins: top, url: self.registration.scope },
      actions: [
        { action: 'open', title: '📊 เปิด Dashboard' },
        { action: 'dismiss', title: '✕ ปิด' }
      ]
    });
  }

  // ─── SELL Notification ───
  if (sellSignals.length > 0) {
    const top = sellSignals.sort((a, b) => a.score - b.score).slice(0, 5);
    const body = top.map(c => `🔴 ${c.label}  ฿${c.price}  RSI:${c.rsi}  Score:${c.score}/10`).join('\n');
    await self.registration.showNotification('📉 จังหวะขาย — Binance TH', {
      body: `${top.length} เหรียญมีสัญญาณ SELL เวลา ${now}\n\n${body}`,
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      tag: 'sell-signal',
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      data: { type: 'sell', coins: top, url: self.registration.scope },
      actions: [
        { action: 'open', title: '📊 เปิด Dashboard' },
        { action: 'dismiss', title: '✕ ปิด' }
      ]
    });
  }

  // ─── No Signal ───
  if (buySignals.length === 0 && sellSignals.length === 0) {
    await self.registration.showNotification('🟡 ไม่มีสัญญาณชัด — Binance TH', {
      body: `ตรวจ ${COINS.length} เหรียญแล้ว เวลา ${now}\nยังไม่มีสัญญาณ BUY/SELL ที่ชัดเจน — รอ 4H ถัดไป`,
      icon: '/icon-192.png',
      tag: 'no-signal',
      renotify: true,
      silent: true,
      data: { type: 'none', url: self.registration.scope }
    });
  }

  // ─── Notify page (live update) ───
  const cls = await clients.matchAll({ type: 'window' });
  cls.forEach(c => c.postMessage({ type: 'SIGNAL_UPDATE', buy: buySignals, sell: sellSignals }));
}

// ─── Notification Click ───
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      const existing = cls.find(c => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

// ─── Push event (for server-sent push) ───
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(self.registration.showNotification(data.title, data.options || {}));
});
