import fetch from "node-fetch";
import fs from "fs";

// ═════════════════════════════════════════════════════════════
//  BOT v5 PRO — entradas optimizadas
// ═════════════════════════════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MAX_SIZE_PCT: 0.05,

  MIN_VOLUME_24H: 300000,
  PRICE_MIN: 0.25,
  PRICE_MAX: 0.75,
  MIN_LIQUIDITY: 40000,
  MIN_HOURS_TO_RESOLVE: 48,

  VOLUME_SPIKE: 1.5,
  MOMENTUM: 0.02,
  LIQ_DROP: 0.03,

  MIN_SCORE: 0.45, // 🔥 MÁS SELECTIVO

  MIN_TREND_CYCLES: 2,
  MAX_SAME_CATEGORY: 1,

  STOP_LOSS: 0.10,
  TAKE_PROFIT: 0.15,
  TRAILING: 0.05,
  MAX_DD: 0.25,
  MAX_HOLD_DAYS: 7,

  FEES: 0.005,
  INTERVAL: 60 * 60 * 1000,
};

// ═════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════

let capital = CONFIG.INITIAL_CAPITAL;
let peakEquity = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let marketMemory = {};
let priceHistory = {};
let paused = false;
let cycle = 0;

// ═════════════════════════════════════════════════════════════
// STATE SAVE / LOAD
// ═════════════════════════════════════════════════════════════

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync("state.json"));
    capital = s.capital ?? CONFIG.INITIAL_CAPITAL;
    peakEquity = s.peakEquity ?? CONFIG.INITIAL_CAPITAL;
    openTrades = s.openTrades ?? [];
    closedTrades = s.closedTrades ?? [];
    marketMemory = s.marketMemory ?? {};
    priceHistory = s.priceHistory ?? {};
    paused = s.paused ?? false;
  } catch {
    console.log("⚠ Sin estado previo");
  }
}

function saveState() {
  fs.writeFileSync(
    "state.json",
    JSON.stringify(
      { capital, peakEquity, openTrades, closedTrades, marketMemory, priceHistory, paused },
      null,
      2
    )
  );
}

// ═════════════════════════════════════════════════════════════
// UTILS
// ═════════════════════════════════════════════════════════════

const ts = () => new Date().toISOString().slice(0, 19).replace("T", " ");
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
// CATEGORÍAS (anti-correlación)
// ═════════════════════════════════════════════════════════════

function getCategory(slug) {
  const s = slug.toLowerCase();
  if (["nba","nfl","soccer"].some(k => s.includes(k))) return "sports";
  if (["election","president"].some(k => s.includes(k))) return "politics";
  if (["btc","crypto","eth"].some(k => s.includes(k))) return "crypto";
  return "other";
}

function isTooCorrelated(slug) {
  const cat = getCategory(slug);
  return openTrades.filter(t => getCategory(t.slug) === cat).length >= CONFIG.MAX_SAME_CATEGORY;
}

// ═════════════════════════════════════════════════════════════
// 🔥 NUEVO — FILTRO MERCADO MUERTO
// ═════════════════════════════════════════════════════════════

function isDeadMarket(m) {
  const history = priceHistory[m.slug] || [];
  if (history.length < 3) return false;

  const prices = history.map(h => h.price);
  const range = Math.max(...prices) - Math.min(...prices);

  return range < 0.01;
}

// ═════════════════════════════════════════════════════════════
// SCORE
// ═════════════════════════════════════════════════════════════

function calcScore(m) {
  const prev = marketMemory[m.slug];
  const history = priceHistory[m.slug] || [];
  let score = 0;

  if (!prev) {
    if (m.volume24h > CONFIG.MIN_VOLUME_24H * 3 && m.price > 0.4 && m.price < 0.6) {
      score += 0.30;
    }
    return { score, detail: "primer ciclo filtrado" };
  }

  const details = [];

  const volRatio = prev.volume24h > 0 ? m.volume24h / prev.volume24h : 1;
  if (volRatio >= CONFIG.VOLUME_SPIKE) {
    const s = Math.min(0.35, 0.35 * (volRatio - 1) / 2);
    score += s;
    details.push(`Vol x${volRatio.toFixed(1)}`);
  }

  if (history.length >= CONFIG.MIN_TREND_CYCLES) {
    const recent = history.slice(-CONFIG.MIN_TREND_CYCLES).map(h => h.price);
    recent.push(m.price);

    let up = 0, down = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) up++;
      else if (recent[i] < recent[i - 1]) down++;
    }

    const total = recent.length - 1;
    const strength = Math.max(up, down) / total;
    const move = Math.abs((m.price - recent[0]) / recent[0]);

    if (strength >= 0.66 && move >= CONFIG.MOMENTUM * 1.5) {
      score += Math.min(0.35, 0.35 * strength);
      details.push("trend");
    }
  }

  if (prev.liquidity > 0) {
    const drop = (prev.liquidity - m.liquidity) / prev.liquidity;
    if (drop >= CONFIG.LIQ_DROP && m.volume24h > prev.volume24h) {
      score += 0.2;
      details.push("liq");
    }
  }

  return { score: Math.min(1, score), detail: details.join(" | ") };
}

// ═════════════════════════════════════════════════════════════
// POSITION SIZE
// ═════════════════════════════════════════════════════════════

function calcSize(price) {
  const risk = capital * CONFIG.RISK_PER_TRADE;
  const stop = price * CONFIG.STOP_LOSS;
  let s = stop > 0 ? risk / stop : risk;
  s = Math.min(s, capital * CONFIG.MAX_SIZE_PCT);
  return Math.max(1, Number(s.toFixed(2)));
}

// ═════════════════════════════════════════════════════════════
// TRADES
// ═════════════════════════════════════════════════════════════

function openTrade(m, scoreData) {
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
    score: scoreData.score,
  });

  log(`🟢 OPEN ${m.question}`);
}

function closeTrade(t, price, reason) {
  const gross = t.size * (price / t.entry);
  const fee = gross * CONFIG.FEES;
  const net = gross - fee;
  const pnl = net - t.size;

  capital += net;

  openTrades = openTrades.filter(x => x !== t);
  closedTrades.push({ ...t, pnl, reason });

  log(`${pnl >= 0 ? "💰" : "🛑"} CLOSE ${reason} PnL ${pnl.toFixed(2)}`);
}

// ═════════════════════════════════════════════════════════════
// MANAGE
// ═════════════════════════════════════════════════════════════

function manage(t, price) {
  const pnl = (price - t.entry) / t.entry;
  const days = (Date.now() - new Date(t.openDate)) / 86400000;

  if (days > CONFIG.MAX_HOLD_DAYS) return closeTrade(t, price, "TIMEOUT");
  if (pnl <= -CONFIG.STOP_LOSS) return closeTrade(t, price, "STOP");

  if (pnl >= CONFIG.TAKE_PROFIT && !t.partial) {
    const half = t.size * 0.5;
    capital += half * (price / t.entry);
    t.size *= 0.5;
    t.partial = true;
    t.peak = price;
    return;
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
  const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30");
  const data = await res.json();

  return data.map(m => {
    let price = 0;
    try {
      const p = JSON.parse(m.outcomePrices || "[0]");
      price = parseFloat(p[0]) || 0;
    } catch {
      price = parseFloat(m.lastPrice) || 0;
    }

    return {
      slug: m.slug,
      question: m.question,
      price,
      volume24h: parseFloat(m.volume24hr) || 0,
      liquidity: parseFloat(m.liquidity) || 0,
      endDate: m.endDate,
    };
  });
}

// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════

async function run() {
  cycle++;
  log(`CICLO ${cycle}`);

  const markets = await getMarkets();
  const prev = { ...marketMemory };

  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manage(t, m.price);
  }

  if (!paused) {
    for (const m of markets) {
      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
      if (!m || !m.slug) continue;

      if (isDeadMarket(m)) continue;
      if (isTooCorrelated(m.slug)) continue;

      const score = calcScore(m);
      if (score.score < CONFIG.MIN_SCORE) continue;

      openTrade(m, score);
    }
  }

  markets.forEach(m => {
    marketMemory[m.slug] = {
      price: m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
    };

    if (!priceHistory[m.slug]) priceHistory[m.slug] = [];
    priceHistory[m.slug].push({ price: m.price });
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
run();
