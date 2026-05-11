import fetch from "node-fetch";
import fs from "fs";

let CONFIG = {
  INITIAL_CAPITAL: 200,

  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MAX_POSITIONS_PER_MARKET: 1,

  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,

  MIN_VOLUME: 300000,
  MIN_LIQ: 100000,

  MIN_SCORE: 0.22,

  FEES: 0.005,

  STOP_LOSS: 0.07,
  TAKE_PROFIT: 0.10,
  TRAILING_STOP: 0.04,

  INTERVAL: 30 * 60 * 1000,

  MAX_CONSECUTIVE_LOSSES: 3,
  DRAWDOWN_LIMIT: 0.15,

  MAX_HOLD_DAYS: 5,
};

const BOTS = {
  A: { MIN_SCORE: 0.20 },
  B: { MIN_SCORE: 0.25 },
  C: { MIN_SCORE: 0.30 },
};

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

const ts = () => new Date().toISOString();
const log = m => console.log(`[${ts()}] ${m}`);

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync("state.json"));
  } catch {}

  for (const k of Object.keys(BOTS)) {
    if (!state.bots[k]) {
      state.bots[k] = createBotState();
    }
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

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
  }));
}

function score(m, hist) {
  if (!hist || hist.length < 4) return 0;

  const moves = [];

  for (let i = 1; i < hist.length; i++) {
    moves.push(
      (hist[i].price - hist[i - 1].price) /
        hist[i - 1].price
    );
  }

  const avgMove =
    moves.reduce((a, b) => a + b, 0) /
    moves.length;

  const consistency =
    moves.filter(x => x > 0).length /
    moves.length;

  const volRatio =
    hist.at(-2).volume > 0
      ? m.volume / hist.at(-2).volume
      : 1;

  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (avgMove > 0.003) s += 0.35;
  if (consistency > 0.75) s += 0.25;
  if (volRatio > 1.3) s += 0.20;
  if (dist < 0.12) s += 0.20;
  if (dist > 0.18) s -= 0.30;

  return Math.max(0, Math.min(1, s));
}

function equity(bot, markets) {
  let eq = bot.cash;

  for (const t of bot.openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) eq += t.shares * m.price;
  }

  return eq;
}

function openTrade(bot, m) {
  const cost = bot.cash * CONFIG.RISK_PER_TRADE;
  const fee = cost * CONFIG.FEES;

  if (bot.cash < cost + fee) return;

  bot.cash -= cost + fee;

  bot.openTrades.push({
    slug: m.slug,
    entry: m.price,
    costBasis: cost,
    shares: cost / m.price,
    peak: m.price,
    openedAt: ts(),
  });

  log(`OPEN ${m.slug}`);
}

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

  bot.openTrades =
    bot.openTrades.filter(x => x !== t);

  bot.consecutiveLosses =
    pnl < 0
      ? bot.consecutiveLosses + 1
      : 0;

  if (
    bot.consecutiveLosses >=
    CONFIG.MAX_CONSECUTIVE_LOSSES
  ) {
    bot.paused = true;
  }
}

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

  if (move > 0.04 && trail >= CONFIG.TRAILING_STOP)
    return closeTrade(bot, t, price, "TRAIL");

  if (age > CONFIG.MAX_HOLD_DAYS)
    return closeTrade(bot, t, price, "TIME");
}

async function run() {
  const markets = await getMarkets();

  for (const m of markets) {
    if (!state.marketMemory[m.slug])
      state.marketMemory[m.slug] = [];

    state.marketMemory[m.slug].push({
      price: m.price,
      volume: m.volume,
    });

    if (state.marketMemory[m.slug].length > 6)
      state.marketMemory[m.slug].shift();
  }

  for (const m of markets) {
    for (const key of Object.keys(BOTS)) {
      const bot = state.bots[key];

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

      const s = score(
        m,
        state.marketMemory[m.slug]
      );

      if (s >= BOTS[key].MIN_SCORE)
        openTrade(bot, m);
    }
  }

  for (const key of Object.keys(BOTS)) {
    const bot = state.bots[key];

    const eq = equity(bot, markets);

    if (eq > bot.peakEquity)
      bot.peakEquity = eq;

    const dd =
      (bot.peakEquity - eq) /
      bot.peakEquity;

    if (dd > CONFIG.DRAWDOWN_LIMIT)
      bot.paused = true;

    log(
      `${key} eq=${eq.toFixed(2)} dd=${(
        dd * 100
      ).toFixed(1)}%`
    );
  }

  saveState();

  setTimeout(run, CONFIG.INTERVAL);
}

loadState();
run();
