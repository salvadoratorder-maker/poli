import fetch from "node-fetch";
import fs from "fs";

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MAX_POSITIONS_PER_MARKET: 1,

  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,
  MIN_VOLUME: 300000,
  MIN_LIQ: 100000,

  FEES: 0.02,
  INTERVAL: 5 * 60 * 1000,

  MAX_CONSECUTIVE_LOSSES: 3,
  DRAWDOWN_LIMIT: 0.15,

  // 🔧 AJUSTES QUE PEDISTE
  MIN_ENTRY_MOVE: 0.005,        // antes 1%
  MIN_SCORE_BASE: 0.22,         // antes 0.30
  MIN_HOURS_TO_RESOLVE: 48,     // antes 72

  // 🧠 control de sobreoperación (CLAVE)
  MAX_TRADES_PER_DAY: 6,
};

let state = {
  bots: {},
  marketMemory: {},
};

const BOTS = {
  A: { MIN_SCORE: 0.20 },
  B: { MIN_SCORE: 0.30 },
  C: { MIN_SCORE: 0.25 },
};

for (const k of Object.keys(BOTS)) {
  state.bots[k] = {
    cash: CONFIG.INITIAL_CAPITAL,
    openTrades: [],
    closedTrades: [],
    consecutiveLosses: 0,
    peakEquity: CONFIG.INITIAL_CAPITAL,
    paused: false,
    tradesToday: 0,
    lastTradeDay: null,
  };
}

// ═════════════════════════════════════
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync("state.json"));
    state = s;
    log("🔁 Estado cargado");
  } catch {
    log("⚠️ Nuevo estado");
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ═════════════════════════════════════
// PRECIO
function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");
    const prices = raw.map(p => parseFloat(p)).filter(p => !isNaN(p) && p > 0 && p < 1);
    if (prices.length === 0) return parseFloat(m.lastPrice) || 0;
    return prices[0];
  } catch {
    return parseFloat(m.lastPrice) || 0;
  }
}

// ═════════════════════════════════════
// API
async function getMarkets() {
  const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30");
  const data = await res.json();

  return data.map(m => ({
    slug: m.slug,
    price: extractPrice(m),
    volume: Number(m.volume24hr) || 0,
    liquidity: Number(m.liquidity) || 0,
    endDate: m.endDate || null,
  }));
}

// ═════════════════════════════════════
// SCORE OPTIMIZADO
function score(m, prev) {
  if (!prev || !prev.timestamp || Date.now() - prev.timestamp > 2 * CONFIG.INTERVAL) return 0;

  const move = (m.price - prev.price) / prev.price;
  const vol = prev.volume > 0 ? m.volume / prev.volume : 1;
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  // Momentum sano
  if (move > 0 && move <= 0.04) s += 0.35;

  // Volumen fuerte
  if (vol > 1.5) s += 0.30;

  // Precio no caro
  if (m.price < 0.65) s += 0.15;

  // Cercanía a fair value
  if (dist < 0.10) s += 0.10;

  // Penalizaciones
  if (move > 0.07) s -= 0.25;     // pico
  if (dist > 0.18) s -= 0.25;     // lejos de 0.5

  return Math.max(0, Math.min(1, s));
}

// ═════════════════════════════════════
// EQUITY
function equity(bot, markets) {
  let eq = bot.cash;
  for (const t of bot.openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (!m) continue;
    eq += t.shares * m.price;
  }
  return eq;
}

// ═════════════════════════════════════
// TRADES
function openTrade(bot, m, s) {
  const size = bot.cash * CONFIG.RISK_PER_TRADE;
  const fee = size * CONFIG.FEES;
  const total = size + fee;

  if (bot.cash < total) return;

  bot.cash -= total;

  bot.openTrades.push({
    slug: m.slug,
    entry: m.price,
    costBasis: size,
    shares: size / m.price,
    openedAt: ts(),
  });

  bot.tradesToday++;

  log(`🟢 OPEN ${m.slug} @${m.price.toFixed(3)} | score ${s.toFixed(2)}`);
}

function closeTrade(bot, t, price, reason) {
  const value = t.shares * price;
  const fee = value * CONFIG.FEES;
  const net = value - fee;
  const pnl = net - t.costBasis;

  bot.cash += net;

  bot.closedTrades.push({
    slug: t.slug,
    entry: t.entry,
    exit: price,
    pnl,
    reason,
    openedAt: t.openedAt,
    closedAt: ts(),
  });

  bot.openTrades = bot.openTrades.filter(x => x !== t);

  bot.consecutiveLosses = pnl < 0 ? bot.consecutiveLosses + 1 : 0;
  if (bot.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) bot.paused = true;

  log(`${pnl >= 0 ? "💰" : "🛑"} CLOSE ${reason} pnl:$${pnl.toFixed(2)}`);
}

function manage(bot, t, price) {
  const move = (price - t.entry) / t.entry;

  if (move <= -0.07) return closeTrade(bot, t, price, "SL");
  if (move >= 0.10) return closeTrade(bot, t, price, "TP");
}

// ═════════════════════════════════════
// MAIN LOOP
async function run() {
  const markets = await getMarkets();

  const filtered = markets.filter(m => {
    if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) return false;
    if (m.volume < CONFIG.MIN_VOLUME) return false;
    if (m.liquidity < CONFIG.MIN_LIQ) return false;

    if (m.endDate) {
      const hours = (new Date(m.endDate) - Date.now()) / 3600000;
      if (hours < CONFIG.MIN_HOURS_TO_RESOLVE) return false;
    }

    return true;
  });

  let openMarketCounts = {};
  for (const b of Object.values(state.bots)) {
    for (const t of b.openTrades) {
      openMarketCounts[t.slug] = (openMarketCounts[t.slug] || 0) + 1;
    }
  }

  for (const m of filtered) {
    const prev = state.marketMemory[m.slug];

    for (const key of Object.keys(BOTS)) {
      const bot = state.bots[key];

      // reset diario
      if (bot.lastTradeDay !== today()) {
        bot.tradesToday = 0;
        bot.lastTradeDay = today();
      }

      // gestionar trades
      for (const t of [...bot.openTrades]) {
        if (t.slug === m.slug) manage(bot, t, m.price);
      }

      if (bot.paused) continue;
      if (bot.tradesToday >= CONFIG.MAX_TRADES_PER_DAY) continue;
      if (bot.openTrades.length >= CONFIG.MAX_OPEN_TRADES) continue;
      if ((openMarketCounts[m.slug] || 0) >= CONFIG.MAX_POSITIONS_PER_MARKET) continue;

      if (!prev) continue;

      const move = (m.price - prev.price) / prev.price;
      if (move < CONFIG.MIN_ENTRY_MOVE) continue;

      const s = score(m, prev);
      if (s < BOTS[key].MIN_SCORE) continue;

      openTrade(bot, m, s);
      openMarketCounts[m.slug] = (openMarketCounts[m.slug] || 0) + 1;
    }

    state.marketMemory[m.slug] = {
      price: m.price,
      volume: m.volume,
      timestamp: Date.now(),
    };
  }

  for (const key of Object.keys(BOTS)) {
    const bot = state.bots[key];
    const eq = equity(bot, markets);

    if (eq > bot.peakEquity) bot.peakEquity = eq;

    const dd = (bot.peakEquity - eq) / bot.peakEquity;
    if (dd > CONFIG.DRAWDOWN_LIMIT) bot.paused = true;

    const pnl = eq - CONFIG.INITIAL_CAPITAL;

    log(`📊 ${key} | Cash:${bot.cash.toFixed(2)} | Eq:${eq.toFixed(2)} | PnL:${pnl.toFixed(2)} | Trades:${bot.tradesToday} | Paused:${bot.paused}`);
  }

  saveState();
  setTimeout(run, CONFIG.INTERVAL);
}

loadState();
run();
