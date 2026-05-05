import fetch from "node-fetch";
import fs from "fs";

// ═════════════════════════════════════════════
// CONFIG
// ═════════════════════════════════════════════
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

  MIN_ENTRY_MOVE: 0.005,
  MAX_TRADES_PER_DAY: 6,
};

// ═════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════
let state = {
  bots: {},
  marketMemory: {},
};

const BOTS = {
  A: { MIN_SCORE: 0.15 },
  B: { MIN_SCORE: 0.20 },
  C: { MIN_SCORE: 0.18 },
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

// ═════════════════════════════════════════════
// UTILS
// ═════════════════════════════════════════════
const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);
const today = () => new Date().toISOString().slice(0, 10);

// ═════════════════════════════════════════════
// PERSISTENCE
// ═════════════════════════════════════════════
function loadState() {
  try {
    state = JSON.parse(fs.readFileSync("state.json"));
    log("🔁 Estado cargado");
  } catch {
    log("⚠️ Nuevo estado");
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

// ═════════════════════════════════════════════
// PRICE
// ═════════════════════════════════════════════
function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");
    const prices = raw.map(p => parseFloat(p)).filter(p => !isNaN(p) && p > 0 && p < 1);
    return prices.length ? prices[0] : parseFloat(m.lastPrice) || 0;
  } catch {
    return parseFloat(m.lastPrice) || 0;
  }
}

// ═════════════════════════════════════════════
// API
// ═════════════════════════════════════════════
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

// ═════════════════════════════════════════════
// SCORE
// ═════════════════════════════════════════════
function score(m, prev) {
  if (!prev || Date.now() - prev.timestamp > 2 * CONFIG.INTERVAL) return 0;

  const move = (m.price - prev.price) / prev.price;
  const vol = prev.volume > 0 ? m.volume / prev.volume : 1;
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (move > 0 && move <= 0.04) s += 0.35;
  if (vol > 1.5) s += 0.30;
  if (m.price < 0.65) s += 0.15;
  if (dist < 0.10) s += 0.10;

  if (move > 0.07) s -= 0.25;
  if (dist > 0.18) s -= 0.25;

  return Math.max(0, Math.min(1, s));
}

// ═════════════════════════════════════════════
// EQUITY
// ═════════════════════════════════════════════
function equity(bot, markets) {
  let eq = bot.cash;
  for (const t of bot.openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) eq += t.shares * m.price;
  }
  return eq;
}

// ═════════════════════════════════════════════
// TRADING
// ═════════════════════════════════════════════
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

  log(`🟢 OPEN ${m.slug} @${m.price.toFixed(3)} score:${s.toFixed(2)}`);
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

// ═════════════════════════════════════════════
// ANALYTICS (EDGE REAL)
// ═════════════════════════════════════════════
function analyzeBot(bot) {
  const trades = bot.closedTrades;
  if (trades.length < 5) return { status: "NO_DATA" };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winrate = wins.length / trades.length;
  const totalPnL = trades.reduce((a, t) => a + t.pnl, 0);

  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;

  const expectancy = (winrate * avgWin) - ((1 - winrate) * avgLoss);
  const profitFactor = avgLoss > 0 ? (winrate * avgWin) / ((1 - winrate) * avgLoss) : Infinity;

  const returns = trades.map(t => t.pnl);
  const avgReturn = totalPnL / trades.length;
  const stdDev = Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - avgReturn, 2), 0) / trades.length);
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(trades.length) : 0;

  let maxLossStreak = 0, current = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      current++;
      maxLossStreak = Math.max(maxLossStreak, current);
    } else current = 0;
  }

  const topWins = [...trades].sort((a,b)=>b.pnl-a.pnl)
    .slice(0, Math.max(1, Math.floor(trades.length*0.1)));

  const concentration = totalPnL !== 0
    ? topWins.reduce((a,t)=>a+t.pnl,0) / totalPnL
    : 0;

  return {
    trades: trades.length,
    expectancy,
    profitFactor,
    sharpe,
    winrate,
    concentration,
    status: expectancy > 0 ? "EDGE" : "NO_EDGE",
  };
}

// ═════════════════════════════════════════════
// MAIN LOOP
// ═════════════════════════════════════════════
async function run() {
  const markets = await getMarkets();

  const filtered = markets.filter(m =>
    m.price >= CONFIG.PRICE_MIN &&
    m.price <= CONFIG.PRICE_MAX &&
    m.volume >= CONFIG.MIN_VOLUME &&
    m.liquidity >= CONFIG.MIN_LIQ
  );

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

      if (bot.lastTradeDay !== today()) {
        bot.tradesToday = 0;
        bot.lastTradeDay = today();
      }

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

  // 📊 ANALYSIS OUTPUT
  for (const key of Object.keys(BOTS)) {
    const bot = state.bots[key];
    const eq = equity(bot, markets);
    const pnl = eq - CONFIG.INITIAL_CAPITAL;

    const stats = analyzeBot(bot);

    if (stats.status === "NO_DATA") {
      log(`🤖 ${key} esperando datos (${bot.closedTrades.length} trades)`);
      continue;
    }

    log(`📊 ${key} | PnL:${pnl.toFixed(2)} | WR:${(stats.winrate*100).toFixed(0)}% | Exp:${stats.expectancy.toFixed(3)} | PF:${stats.profitFactor.toFixed(2)} | Sharpe:${stats.sharpe.toFixed(2)} | ${stats.status}`);
  }

  saveState();
  setTimeout(run, CONFIG.INTERVAL);
}

// ═════════════════════════════════════════════
loadState();
run();
