import fetch from "node-fetch";
import fs from "fs";

// ═════════════════════════════════════════════════════════════
//  BOT v7 — Balance real (calidad + frecuencia)
// ═════════════════════════════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL:       200,
  RISK_PER_TRADE:        0.02,
  MAX_OPEN_TRADES:       3,
  MAX_SIZE_PCT:          0.05,

  MIN_VOLUME_24H:        300000,
  PRICE_MIN:             0.25,
  PRICE_MAX:             0.75,
  MIN_LIQUIDITY:         40000,
  MIN_HOURS_TO_RESOLVE:  72,

  VOLUME_SPIKE:          1.5,
  MOMENTUM:              0.02,
  LIQ_DROP:              0.03,

  MIN_SCORE:             0.30,
  MIN_TREND_CYCLES:      2,
  MAX_SAME_CATEGORY:     1,

  STOP_LOSS:             0.08,
  TAKE_PROFIT:           0.08,
  TRAILING:              0.04,

  MAX_DD:                0.25,
  MAX_HOLD_DAYS:         7,
  FEES:                  0.005,
  INTERVAL:              60 * 60 * 1000,
};

// ═════════════════════════════════════════════════════════════
// ESTADO
// ═════════════════════════════════════════════════════════════
let capital      = CONFIG.INITIAL_CAPITAL;
let peakEquity   = CONFIG.INITIAL_CAPITAL;
let openTrades   = [];
let closedTrades = [];
let marketMemory = {};
let priceHistory = {};
let cycle        = 0;
let paused       = false;

// ═════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync("state.json"));
    capital      = s.capital      ?? CONFIG.INITIAL_CAPITAL;
    peakEquity   = s.peakEquity   ?? CONFIG.INITIAL_CAPITAL;
    openTrades   = s.openTrades   ?? [];
    closedTrades = s.closedTrades ?? [];
    marketMemory = s.marketMemory ?? {};
    priceHistory = s.priceHistory ?? {};
    paused       = s.paused       ?? false;
    log(`[LOAD] Capital: $${capital.toFixed(2)} | Trades: ${openTrades.length}`);
  } catch {
    log("⚠ Sin estado previo");
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify({
    capital, peakEquity, openTrades, closedTrades,
    marketMemory, priceHistory, paused,
  }, null, 2));
}

// ═════════════════════════════════════════════════════════════
// UTILS
// ═════════════════════════════════════════════════════════════
const ts  = () => new Date().toISOString().slice(0,19).replace("T"," ");
const log = (msg) => console.log(`[${ts()}] ${msg}`);

function equity(markets) {
  let eq = capital;
  for (const t of openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) eq += t.size * (m.price / t.entry);
  }
  return eq;
}

// ═════════════════════════════════════════════════════════════
// CATEGORY
// ═════════════════════════════════════════════════════════════
function getCategory(slug) {
  const s = (slug || "").toLowerCase();
  if (["nba","nfl","nhl","mlb","soccer"].some(k => s.includes(k))) return "sports";
  if (["election","president"].some(k => s.includes(k))) return "politics";
  if (["btc","crypto","eth"].some(k => s.includes(k))) return "crypto";
  return "other";
}

function isTooCorrelated(slug) {
  const cat = getCategory(slug);
  return openTrades.filter(t => getCategory(t.slug) === cat).length >= CONFIG.MAX_SAME_CATEGORY;
}

// ═════════════════════════════════════════════════════════════
// SCORE
// ═════════════════════════════════════════════════════════════
function calcScore(m) {
  const prev = marketMemory[m.slug];
  const history = priceHistory[m.slug] || [];
  let score = 0;

  if (!prev) return { score: 0 };

  const moveShort = (m.price - prev.price) / prev.price;

  // volumen
  if (m.volume24h > prev.volume24h * CONFIG.VOLUME_SPIKE) {
    score += 0.3;
  }

  // tendencia
  if (history.length >= 2) {
    const first = history[0].price;
    const totalMove = (m.price - first) / first;

    if (Math.abs(totalMove) > CONFIG.MOMENTUM) {
      score += 0.3;
    }

    // agotamiento
    if (totalMove > 0.15) {
      score -= 0.2;
    }
  }

  // liquidez
  if (prev.liquidity > m.liquidity) {
    score += 0.2;
  }

  // penalización picos
  if (moveShort > 0.08) score -= 0.15;
  else if (moveShort > 0.05) score -= 0.08;

  return { score: Math.max(0, Math.min(1, score)) };
}

// ═════════════════════════════════════════════════════════════
// SIZE (FIX CLAVE)
// ═════════════════════════════════════════════════════════════
function calcSize(price) {
  const risk = capital * CONFIG.RISK_PER_TRADE;
  const stopDist = price * CONFIG.STOP_LOSS;
  let s = risk / stopDist;

  return Math.min(
    capital * CONFIG.MAX_SIZE_PCT,
    Math.max(1, parseFloat(s.toFixed(2)))
  );
}

// ═════════════════════════════════════════════════════════════
// TRADES
// ═════════════════════════════════════════════════════════════
function openTrade(m) {
  const s = calcSize(m.price);
  if (capital < s) return;

  capital -= s;

  openTrades.push({
    slug: m.slug,
    entry: m.price,
    size: s,
    peak: m.price,
    partial: false,
    openDate: ts(),
  });

  log(`🟢 OPEN ${m.slug} @ ${m.price}`);
}

function closeTrade(t, price, reason) {
  const gross = t.size * (price / t.entry);
  const fee   = gross * CONFIG.FEES;
  const net   = gross - fee;

  capital += net;
  openTrades = openTrades.filter(x => x !== t);

  log(`CLOSE ${reason} | PnL: ${(net - t.size).toFixed(2)}`);
}

function manage(t, price) {
  const pnl = (price - t.entry) / t.entry;
  const days = (Date.now() - new Date(t.openDate)) / 86400000;

  if (days > CONFIG.MAX_HOLD_DAYS) return closeTrade(t, price, "TIMEOUT");
  if (pnl <= -CONFIG.STOP_LOSS) return closeTrade(t, price, "SL");

  if (pnl >= CONFIG.TAKE_PROFIT && !t.partial) {
    const half = t.size * 0.5;
    const value = half * (price / t.entry);
    capital += value;
    t.size *= 0.5;
    t.partial = true;
  }

  if (t.partial) {
    if (price > t.peak) t.peak = price;
    const drop = (t.peak - price) / t.peak;
    if (drop > CONFIG.TRAILING) closeTrade(t, price, "TRAIL");
  }
}

// ═════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════
async function getMarkets() {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30");
    const data = await res.json();

    return data.map(m => ({
      slug: m.slug,
      price: parseFloat(JSON.parse(m.outcomePrices)[0]),
      volume24h: parseFloat(m.volume24hr),
      liquidity: parseFloat(m.liquidity),
      endDate: m.endDate
    }));
  } catch {
    return [];
  }
}

// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════
async function run() {
  cycle++;
  log(`CICLO ${cycle}`);

  const markets = await getMarkets();
  if (!markets.length) return setTimeout(run, CONFIG.INTERVAL);

  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manage(t, m.price);
  }

  if (!paused) {
    for (const m of markets) {
      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
      if (isTooCorrelated(m.slug)) continue;

      const { score } = calcScore(m);
      if (score >= CONFIG.MIN_SCORE) openTrade(m);
    }
  }

  markets.forEach(m => {
    marketMemory[m.slug] = m;
    if (!priceHistory[m.slug]) priceHistory[m.slug] = [];
    priceHistory[m.slug].push(m);
    if (priceHistory[m.slug].length > 5)
      priceHistory[m.slug] = priceHistory[m.slug].slice(-5);
  });

  const eq = equity(markets);
  if (eq > peakEquity) peakEquity = eq;
  const dd = (peakEquity - eq) / peakEquity;

  if (dd > CONFIG.MAX_DD) paused = true;
  if (paused && dd < CONFIG.MAX_DD * 0.5) paused = false;

  saveState();
  setTimeout(run, CONFIG.INTERVAL);
}

// START
loadState();
log("🚀 BOT v7 iniciado");
run();
