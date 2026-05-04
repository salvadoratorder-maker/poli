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
  DRY_RUN: false,
};

let state = {
  bots: {},
  marketMemory: {},
  marketHistory: {},
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
  };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync("state.json"));
    state = s;
    for (const k of Object.keys(BOTS)) {
      state.bots[k] ??= {
        cash: CONFIG.INITIAL_CAPITAL,
        openTrades: [],
        closedTrades: [],
        consecutiveLosses: 0,
        peakEquity: CONFIG.INITIAL_CAPITAL,
        paused: false,
      };
    }
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

async function getMarkets() {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30");
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return data.map(m => ({
      slug: m.slug,
      price: extractPrice(m),
      volume: Number(m.volume24hr) || 0,
      liquidity: Number(m.liquidity) || 0,
    }));
  } catch (e) {
    log(`❌ getMarkets: ${e.message}`);
    return [];
  }
}

function score(m, prev, history = null) {
  if (!prev || !prev.timestamp) return 0;
  if (Date.now() - prev.timestamp > 2 * CONFIG.INTERVAL) return 0;

  const move = prev.price > 0 ? (m.price - prev.price) / prev.price : 0;
  const volRatio = prev.volume > 0 ? m.volume / prev.volume : 1;
  const dist = Math.abs(m.price - 0.5);
  const h = history || state.marketHistory[m.slug] || [];

  if (dist > 0.18) return 0;

  let s = 0;

  if (move > 0.01 && move <= 0.04) {
    s += 0.35;
  } else if (move > 0.04 && move <= 0.07) {
    s += 0.15;
  } else if (move > 0.07) {
    s -= 0.25;
  }

  if (volRatio > 1.3 && volRatio <= 2) {
    s += 0.20;
  } else if (volRatio > 2) {
    s += 0.25;
  }

  if (dist < 0.05) {
    s += 0.25;
  } else if (dist < 0.10) {
    s += 0.15;
  } else if (dist > 0.15) {
    s -= 0.20;
  }

  if (h.length >= 3) {
    const prices = h.map(x => x.price).concat(m.price);
    let up = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) up++;
    }
    const trendStrength = up / prices.length;

    if (trendStrength > 0.66) s += 0.15;
    else if (trendStrength < 0.33) s -= 0.10;
  }

  if (Math.abs(move) < 0.005 && volRatio < 1) {
    s -= 0.15;
  }

  return Math.max(0, Math.min(1, s));
}

function equity(bot, markets) {
  let eq = bot.cash;
  for (const t of bot.openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (!m) continue;
    eq += t.shares * m.price;
  }
  return eq;
}

function openTrade(bot, m, s) {
  const size = bot.cash * CONFIG.RISK_PER_TRADE;
  const buyFee = size * CONFIG.FEES;
  const totalCost = size + buyFee;
  if (bot.cash < totalCost) return;
  bot.cash -= totalCost;
  bot.openTrades.push({ slug: m.slug, entry: m.price, costBasis: size, shares: size / m.price, openedAt: ts(), partial: 0, peak: null });
  log(`🟢 OPEN ${m.slug} @${m.price.toFixed(3)} score:${s.toFixed(2)}`);
}

function closeTrade(bot, t, price, reason) {
  const value = t.shares * price;
  const sellFee = value * CONFIG.FEES;
  const net = value - sellFee;
  const pnl = net - t.costBasis;
  bot.cash += net;
  bot.closedTrades.push({ slug: t.slug, entry: t.entry, exit: price, size: t.costBasis, pnl, reason, openedAt: t.openedAt, closedAt: ts() });
  bot.openTrades = bot.openTrades.filter(x => x !== t);
  bot.consecutiveLosses = pnl < 0 ? bot.consecutiveLosses + 1 : 0;
  if (bot.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) bot.paused = true;
  log(`💰 CLOSE ${reason} pnl:$${pnl.toFixed(2)}`);
}

function manage(bot, t, price) {
  const move = (price - t.entry) / t.entry;
  const days = (Date.now() - new Date(t.openedAt)) / 86400000;
  if (days > 3) return closeTrade(bot, t, price, "TIMEOUT");
  if (move <= -0.07) return closeTrade(bot, t, price, "SL");
  if (move >= 0.10) {
    const takeAmount = t.partial ? 0.25 : 0.5;
    const takeCost = t.costBasis * takeAmount;
    const takeShares = t.shares * takeAmount;
    const value = takeShares * price;
    const fee = value * CONFIG.FEES;
    const net = value - fee;
    const pnl = net - takeCost;
    bot.cash += net;
    t.shares -= takeShares;
    t.costBasis -= takeCost;
    if (!t.partial) t.partial = 1; else t.partial = 2;
    t.peak = price;
    log(`✂️ PARTIAL TP ${Math.round(takeAmount*100)}% pnl:$${pnl.toFixed(2)}`);
    return;
  }
  if (t.partial) {
    if (!t.peak || price > t.peak) t.peak = price;
    const drop = t.peak > 0 ? (t.peak - price) / t.peak : 0;
    if (drop >= 0.04) return closeTrade(bot, t, price, "TRAIL");
  }
}

let isRunning = false;

async function run() {
  if (isRunning) return;
  isRunning = true;
  const markets = await getMarkets();
  const filtered = markets.filter(m => m.price >= CONFIG.PRICE_MIN && m.price <= CONFIG.PRICE_MAX && m.volume >= CONFIG.MIN_VOLUME && m.liquidity >= CONFIG.MIN_LIQ && m.price > 0.01 && m.price < 0.99);
  for (const key of Object.keys(BOTS)) {
    const bot = state.bots[key];
    for (const t of [...bot.openTrades]) {
      const m = markets.find(x => x.slug === t.slug);
      if (!m) continue;
      if (m.price <= 0.01 || m.price >= 0.99) closeTrade(bot, t, m.price, "RESOLVED");
    }
  }

  let openMarketCounts = {};
  for (const b of Object.values(state.bots)) for (const t of b.openTrades) openMarketCounts[t.slug] = (openMarketCounts[t.slug] || 0) + 1;

  for (const m of filtered) {
    const prev = state.marketMemory[m.slug];
    for (const key of Object.keys(BOTS)) {
      const bot = state.bots[key];
      for (const t of [...bot.openTrades]) if (t.slug === m.slug) manage(bot, t, m.price);
      if (bot.paused) continue;
      if (bot.openTrades.length >= CONFIG.MAX_OPEN_TRADES) continue;
      if ((openMarketCounts[m.slug] || 0) >= CONFIG.MAX_POSITIONS_PER_MARKET) continue;
      const s = score(m, prev);
      if (s < BOTS[key].MIN_SCORE) continue;
      if (!CONFIG.DRY_RUN) openTrade(bot, m, s);
      openMarketCounts[m.slug] = (openMarketCounts[m.slug] || 0) + 1;
    }
    state.marketMemory[m.slug] = { price: m.price, volume: m.volume, timestamp: Date.now() };
    if (!state.marketHistory[m.slug]) state.marketHistory[m.slug] = [];
    state.marketHistory[m.slug].push({ price: m.price, volume: m.volume, timestamp: Date.now() });
    if (state.marketHistory[m.slug].length > 8) state.marketHistory[m.slug].shift();
  }

  for (const key of Object.keys(BOTS)) {
    const bot = state.bots[key];
    const eq = equity(bot, markets);
    if (eq > bot.peakEquity) bot.peakEquity = eq;
    const dd = (bot.peakEquity - eq) / bot.peakEquity;
    if (dd > CONFIG.DRAWDOWN_LIMIT) bot.paused = true;
    else if (bot.paused && dd < CONFIG.DRAWDOWN_LIMIT * 0.5) bot.paused = false;
    const wins = bot.closedTrades.filter(t => t.pnl > 0).length;
    const losses = bot.closedTrades.filter(t => t.pnl < 0).length;
    const total = wins + losses;
    const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
    const totalPnl = bot.closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
    const pnl = eq - CONFIG.INITIAL_CAPITAL;
    log(`📊 ${key} | Cash: ${bot.cash.toFixed(2)} | Equity: ${eq.toFixed(2)} | PnL: ${pnl.toFixed(2)} | WR: ${wr}% | Total:$${totalPnl.toFixed(2)} | Losses: ${bot.consecutiveLosses} | Paused: ${bot.paused}`);
  }

  saveState();
  isRunning = false;
  setTimeout(run, CONFIG.INTERVAL);
}

loadState();
run();
