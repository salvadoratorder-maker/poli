import fetch from "node-fetch";
import fs from "fs";

/* ============================================================
   CONFIG
============================================================ */

const CONFIG = {
  INITIAL_CAPITAL: 200,

  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MAX_POSITIONS_PER_MARKET: 1,

  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,

  MIN_VOLUME: 300000,
  MIN_LIQ: 100000,

  MIN_SCORE: 0.22,
  MIN_ENTRY_MOVE: 0.005,

  FEES: 0.02,

  STOP_LOSS: 0.07,
  TAKE_PROFIT: 0.10,
  TRAILING_STOP: 0.04,

  INTERVAL: 5 * 60 * 1000,

  MAX_CONSECUTIVE_LOSSES: 3,
  DRAWDOWN_LIMIT: 0.15,

  MAX_HOLD_DAYS: 5,
};

const BOTS = {
  A: { MIN_SCORE: 0.20 },
  B: { MIN_SCORE: 0.25 },
  C: { MIN_SCORE: 0.30 },
};

/* ============================================================
   STATE
============================================================ */

let state = {
  bots: {},
  marketMemory: {},
};

function createBotState() {
  return {
    cash: CONFIG.INITIAL_CAPITAL,
    openTrades: [],
    closedTrades: [],
    consecutiveLosses: 0,
    peakEquity: CONFIG.INITIAL_CAPITAL,
    paused: false,
  };
}

/* ============================================================
   UTILS
============================================================ */

const ts = () => new Date().toISOString();
const log = m => console.log(`[${ts()}] ${m}`);

/* ============================================================
   PERSISTENCE
============================================================ */

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync("state.json"));
    log("state loaded");
  } catch {
    log("new state");
  }

  for (const k of Object.keys(BOTS)) {
    if (!state.bots[k]) state.bots[k] = createBotState();
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

/* ============================================================
   API
============================================================ */

function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");

    const prices = raw
      .map(Number)
      .filter(p => p > 0 && p < 1);

    if (!prices.length) return Number(m.lastPrice) || 0;

    return prices.reduce((a, b) =>
      Math.abs(b - 0.5) < Math.abs(a - 0.5) ? b : a
    );
  } catch {
    return Number(m.lastPrice) || 0;
  }
}

async function getMarkets() {
  const res = await fetch(
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30"
  );

  const data = await res.json();

  return data.map(m => ({
    slug: m.slug,
    price: extractPrice(m),
    volume: Number(m.volume24hr) || 0,
    liquidity: Number(m.liquidity) || 0,
    endDate: m.endDate,
  }));
}

/* ============================================================
   SCORE
============================================================ */

function score(m, prev) {
  if (!prev) return 0;

  const move = (m.price - prev.price) / prev.price;
  const vol = prev.volume > 0 ? m.volume / prev.volume : 1;
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (move > 0 && move < 0.06) s += 0.35;
  if (vol > 1.3) s += 0.25;
  if (dist < 0.12) s += 0.20;
  if (move > 0.08) s -= 0.20;
  if (dist > 0.18) s -= 0.30;

  return Math.max(0, Math.min(1, s));
}

/* ============================================================
   EQUITY
============================================================ */

function equity(bot, markets) {
  let eq = bot.cash;

  for (const t of bot.openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (!m) continue;
    eq += t.shares * m.price;
  }

  return eq;
}

/* ============================================================
   OPEN
============================================================ */

function openTrade(bot, m, s) {
  const cost = bot.cash * CONFIG.RISK_PER_TRADE;
  const fee = cost * CONFIG.FEES;
  const total = cost + fee;

  if (bot.cash < total) return;

  bot.cash -= total;

  bot.openTrades.push({
    slug: m.slug,
    entry: m.price,
    costBasis: cost,
    shares: cost / m.price,
    peak: m.price,
    openedAt: ts(),
  });

  log(`OPEN ${m.slug} score=${s.toFixed(2)}`);
}

/* ============================================================
   CLOSE
============================================================ */

function closeTrade(bot, t, price, reason) {
  const gross = t.shares * price;
  const fee = gross * CONFIG.FEES;
  const net = gross - fee;
  const pnl = net - t.costBasis;

  bot.cash += net;

  bot.closedTrades.push({
    ...t,
    exit: price,
    pnl,
    reason,
    closedAt: ts(),
  });

  bot.openTrades = bot.openTrades.filter(x => x !== t);

  bot.consecutiveLosses =
    pnl < 0 ? bot.consecutiveLosses + 1 : 0;

  if (
    bot.consecutiveLosses >=
    CONFIG.MAX_CONSECUTIVE_LOSSES
  ) {
    bot.paused = true;
  }

  log(`CLOSE ${reason} pnl=${pnl.toFixed(2)}`);
}

/* ============================================================
   MANAGE
============================================================ */

function manage(bot, t, price) {
  const move = (price - t.entry) / t.entry;

  if (price > t.peak) t.peak = price;

  const trail =
    (t.peak - price) / t.peak;

  const age =
    (Date.now() - new Date(t.openedAt)) /
    86400000;

  if (move <= -CONFIG.STOP_LOSS)
    return closeTrade(bot, t, price, "SL");

  if (move >= CONFIG.TAKE_PROFIT)
    return closeTrade(bot, t, price, "TP");

  if (
    move > 0.04 &&
    trail >= CONFIG.TRAILING_STOP
  )
    return closeTrade(bot, t, price, "TRAIL");

  if (age > CONFIG.MAX_HOLD_DAYS)
    return closeTrade(bot, t, price, "TIME");
}

/* ============================================================
   CLEAN GHOSTS
============================================================ */

function cleanGhostTrades(markets) {
  const valid = new Set(markets.map(m => m.slug));

  for (const bot of Object.values(state.bots)) {
    bot.openTrades = bot.openTrades.filter(t =>
      valid.has(t.slug)
    );
  }
}

/* ============================================================
   RUN
============================================================ */

async function run() {
  const markets = await getMarkets();

  cleanGhostTrades(markets);

  const filtered = markets.filter(
    m =>
      m.price >= CONFIG.PRICE_MIN &&
      m.price <= CONFIG.PRICE_MAX &&
      m.volume >= CONFIG.MIN_VOLUME &&
      m.liquidity >= CONFIG.MIN_LIQ
  );

  const marketCount = {};

  for (const b of Object.values(state.bots)) {
    for (const t of b.openTrades)
      marketCount[t.slug] =
        (marketCount[t.slug] || 0) + 1;
  }

  for (const m of filtered) {
    const prev = state.marketMemory[m.slug];

    for (const k of Object.keys(BOTS)) {
      const bot = state.bots[k];

      for (const t of [...bot.openTrades]) {
        if (t.slug === m.slug)
          manage(bot, t, m.price);
      }

      if (bot.paused) continue;
      if (
        bot.openTrades.length >=
        CONFIG.MAX_OPEN_TRADES
      )
        continue;

      if (
        (marketCount[m.slug] || 0) >=
        CONFIG.MAX_POSITIONS_PER_MARKET
      )
        continue;

      const s = score(m, prev);

      if (s < BOTS[k].MIN_SCORE)
        continue;

      openTrade(bot, m, s);

      marketCount[m.slug] =
        (marketCount[m.slug] || 0) + 1;
    }

    state.marketMemory[m.slug] = {
      price: m.price,
      volume: m.volume,
      ts: Date.now(),
    };
  }

  for (const k of Object.keys(BOTS)) {
    const bot = state.bots[k];

    const eq = equity(bot, markets);

    if (eq > bot.peakEquity)
      bot.peakEquity = eq;

    const dd =
      (bot.peakEquity - eq) /
      bot.peakEquity;

    if (dd > CONFIG.DRAWDOWN_LIMIT)
      bot.paused = true;

    log(
      `${k} cash=${bot.cash.toFixed(
        2
      )} eq=${eq.toFixed(2)} dd=${(
        dd * 100
      ).toFixed(1)}%`
    );
  }

  saveState();

  setTimeout(run, CONFIG.INTERVAL);
}

/* ============================================================
   START
============================================================ */

loadState();
run();
