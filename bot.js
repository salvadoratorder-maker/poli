import fetch from "node-fetch";
import fs from "fs";

// ═════════════════════════════════════════════════════════════
// CONFIG
// ═════════════════════════════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 200,

  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MAX_POSITIONS_PER_MARKET: 1,

  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,

  MIN_VOLUME: 300000,
  MIN_LIQ: 100000,

  MIN_ENTRY_MOVE: 0.005,
  MIN_SCORE: 0.22,

  FEES: 0.02,

  STOP_LOSS: 0.07,
  TAKE_PROFIT: 0.10,

  INTERVAL: 5 * 60 * 1000,

  MAX_CONSECUTIVE_LOSSES: 3,
  DRAWDOWN_LIMIT: 0.15,

  MAX_TRADE_AGE_DAYS: 30,
};

// ═════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════

let state = {
  bots: {},
  marketMemory: {},
};

const BOTS = {
  A: { MIN_SCORE: 0.20 },
  B: { MIN_SCORE: 0.25 },
  C: { MIN_SCORE: 0.30 },
};

for (const key of Object.keys(BOTS)) {
  state.bots[key] = {
    cash: CONFIG.INITIAL_CAPITAL,
    openTrades: [],
    closedTrades: [],
    consecutiveLosses: 0,
    peakEquity: CONFIG.INITIAL_CAPITAL,
    paused: false,
  };
}

// ═════════════════════════════════════════════════════════════
// UTILS
// ═════════════════════════════════════════════════════════════

const ts = () => new Date().toISOString();

const log = (msg) => {
  console.log(`[${ts()}] ${msg}`);
};

// ═════════════════════════════════════════════════════════════
// PERSISTENCE
// ═════════════════════════════════════════════════════════════

function loadState() {
  try {
    const raw = fs.readFileSync("state.json");
    const parsed = JSON.parse(raw);

    state = parsed;

    for (const key of Object.keys(BOTS)) {
      state.bots[key] ??= {
        cash: CONFIG.INITIAL_CAPITAL,
        openTrades: [],
        closedTrades: [],
        consecutiveLosses: 0,
        peakEquity: CONFIG.INITIAL_CAPITAL,
        paused: false,
      };
    }

    log("🔁 State loaded");
  } catch {
    log("⚠️ New state created");
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

// ═════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════

function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");

    const prices = raw
      .map(p => parseFloat(p))
      .filter(p => !isNaN(p) && p > 0 && p < 1);

    if (!prices.length) {
      return parseFloat(m.lastPrice) || 0;
    }

    return prices[0];

  } catch {
    return parseFloat(m.lastPrice) || 0;
  }
}

async function getMarkets() {
  try {

    const res = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30"
    );

    const data = await res.json();

    return data.map(m => ({
      slug: m.slug,

      question: m.question || "",

      price: extractPrice(m),

      volume: Number(m.volume24hr) || 0,

      liquidity: Number(m.liquidity) || 0,

      endDate: m.endDate || null,
    }));

  } catch (e) {

    log(`❌ API ERROR ${e.message}`);

    return [];
  }
}

// ═════════════════════════════════════════════════════════════
// CLEAN GHOST TRADES
// ═════════════════════════════════════════════════════════════

async function cleanGhostTrades(markets) {

  const validSlugs = new Set(markets.map(m => m.slug));

  for (const key of Object.keys(state.bots)) {

    const bot = state.bots[key];

    const cleaned = [];

    for (const t of bot.openTrades) {

      let remove = false;

      // corrupt trade
      if (
        !t.slug ||
        t.entry <= 0 ||
        t.shares <= 0 ||
        t.costBasis <= 0
      ) {
        log(`🧹 ${key} removed corrupt trade`);
        remove = true;
      }

      // market disappeared
      if (!validSlugs.has(t.slug)) {
        log(`👻 ${key} removed ghost trade ${t.slug}`);
        remove = true;
      }

      // stale trade
      const age =
        (Date.now() - new Date(t.openedAt)) / 86400000;

      if (age > CONFIG.MAX_TRADE_AGE_DAYS) {
        log(`⌛ ${key} removed stale trade ${t.slug}`);
        remove = true;
      }

      if (remove) {

        // devolver capital para evitar cash corrupto
        bot.cash += t.costBasis;

      } else {

        cleaned.push(t);
      }
    }

    bot.openTrades = cleaned;
  }
}

// ═════════════════════════════════════════════════════════════
// SCORE
// ═════════════════════════════════════════════════════════════

function score(m, prev) {

  if (
    !prev ||
    !prev.timestamp ||
    Date.now() - prev.timestamp > CONFIG.INTERVAL * 2
  ) {
    return 0;
  }

  const move =
    prev.price > 0
      ? (m.price - prev.price) / prev.price
      : 0;

  const vol =
    prev.volume > 0
      ? m.volume / prev.volume
      : 1;

  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  // bullish momentum
  if (move > 0 && m.price < 0.65) {
    s += 0.20;
  }

  // volume expansion
  if (vol > 1.5) {
    s += 0.30;
  }

  // controlled momentum
  if (move > 0.005 && move <= 0.05) {
    s += 0.30;
  }

  // near fair value
  if (dist < 0.10) {
    s += 0.15;
  }

  // too far from fair
  if (dist > 0.15) {
    s -= 0.30;
  }

  // extreme spike
  if (move > 0.07) {
    s -= 0.20;
  }

  return Math.max(0, Math.min(1, s));
}

// ═════════════════════════════════════════════════════════════
// EQUITY
// ═════════════════════════════════════════════════════════════

function equity(bot, markets) {

  let eq = bot.cash;

  for (const t of bot.openTrades) {

    const m = markets.find(x => x.slug === t.slug);

    if (!m) continue;

    eq += t.shares * m.price;
  }

  return eq;
}

// ═════════════════════════════════════════════════════════════
// OPEN TRADE
// ═════════════════════════════════════════════════════════════

function openTrade(bot, m, s) {

  const size =
    bot.cash * CONFIG.RISK_PER_TRADE;

  const buyFee =
    size * CONFIG.FEES;

  const totalCost =
    size + buyFee;

  if (bot.cash < totalCost) return;

  bot.cash -= totalCost;

  bot.openTrades.push({
    slug: m.slug,

    entry: m.price,

    costBasis: size,

    shares: size / m.price,

    openedAt: ts(),
  });

  log(
    `🟢 OPEN ${m.slug} @${m.price.toFixed(3)} score:${s.toFixed(2)}`
  );
}

// ═════════════════════════════════════════════════════════════
// CLOSE TRADE
// ═════════════════════════════════════════════════════════════

function closeTrade(bot, t, price, reason) {

  const value =
    t.shares * price;

  const sellFee =
    value * CONFIG.FEES;

  const net =
    value - sellFee;

  const pnl =
    net - t.costBasis;

  bot.cash += net;

  bot.closedTrades.push({
    slug: t.slug,

    entry: t.entry,

    exit: price,

    size: t.costBasis,

    pnl,

    reason,

    openedAt: t.openedAt,

    closedAt: ts(),
  });

  bot.openTrades =
    bot.openTrades.filter(x => x !== t);

  if (pnl < 0) {
    bot.consecutiveLosses++;
  } else {
    bot.consecutiveLosses = 0;
  }

  if (
    bot.consecutiveLosses >=
    CONFIG.MAX_CONSECUTIVE_LOSSES
  ) {
    bot.paused = true;

    log(`🛑 BOT paused by losses`);
  }

  log(
    `💰 CLOSE ${reason} | pnl:$${pnl.toFixed(2)}`
  );
}

// ═════════════════════════════════════════════════════════════
// MANAGE
// ═════════════════════════════════════════════════════════════

function manage(bot, t, price) {

  const move =
    (price - t.entry) / t.entry;

  // stop loss
  if (move <= -CONFIG.STOP_LOSS) {
    return closeTrade(bot, t, price, "SL");
  }

  // take profit
  if (move >= CONFIG.TAKE_PROFIT) {
    return closeTrade(bot, t, price, "TP");
  }
}

// ═════════════════════════════════════════════════════════════
// ANALYZE
// ═════════════════════════════════════════════════════════════

function calculateMaxDrawdown(trades) {

  let peak = 0;
  let maxDD = 0;
  let running = 0;

  for (const t of trades) {

    running += t.pnl;

    if (running > peak) {
      peak = running;
    }

    const dd =
      (peak - running) / (peak || 1);

    if (dd > maxDD) {
      maxDD = dd;
    }
  }

  return (maxDD * 100).toFixed(1) + "%";
}

function analyzeBot(bot) {

  const trades = bot.closedTrades;

  if (trades.length < 5) {

    return {
      status: "NO_DATA",
      message: "Need more trades",
    };
  }

  const wins =
    trades.filter(t => t.pnl > 0);

  const losses =
    trades.filter(t => t.pnl <= 0);

  const totalPnL =
    trades.reduce((a, t) => a + t.pnl, 0);

  const winrate =
    wins.length / trades.length;

  const avgWin =
    wins.length
      ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length
      : 0;

  const avgLoss =
    losses.length
      ? Math.abs(
          losses.reduce((a, t) => a + t.pnl, 0) /
          losses.length
        )
      : 0;

  const expectancy =
    (winrate * avgWin) -
    ((1 - winrate) * avgLoss);

  const profitFactor =
    avgLoss > 0
      ? (winrate * avgWin) /
        ((1 - winrate) * avgLoss)
      : Infinity;

  const returns =
    trades.map(t => t.pnl);

  const avgReturn =
    totalPnL / trades.length;

  const stdDev = Math.sqrt(
    returns
      .map(r => Math.pow(r - avgReturn, 2))
      .reduce((a, b) => a + b, 0) /
    trades.length
  );

  const sharpe =
    stdDev > 0
      ? (avgReturn / stdDev) * Math.sqrt(252)
      : 0;

  let maxLossStreak = 0;
  let currentLossStreak = 0;

  for (const t of trades) {

    if (t.pnl <= 0) {

      currentLossStreak++;

      maxLossStreak = Math.max(
        maxLossStreak,
        currentLossStreak
      );

    } else {

      currentLossStreak = 0;
    }
  }

  let rating = "D";

  if (
    profitFactor > 1.5 &&
    winrate > 0.5 &&
    expectancy > 1
  ) {
    rating = "A";
  }

  else if (
    profitFactor > 1.2 &&
    winrate > 0.45 &&
    expectancy > 0.5
  ) {
    rating = "B";
  }

  else if (
    profitFactor > 1 &&
    winrate > 0.4 &&
    expectancy > 0
  ) {
    rating = "C";
  }

  else if (expectancy < 0) {
    rating = "F";
  }

  return {

    trades: trades.length,

    totalPnL: totalPnL.toFixed(2),

    winrate: (winrate * 100).toFixed(1) + "%",

    avgWin: avgWin.toFixed(2),

    avgLoss: avgLoss.toFixed(2),

    expectancy: expectancy.toFixed(3),

    profitFactor: profitFactor.toFixed(2),

    sharpeRatio: sharpe.toFixed(2),

    maxLossStreak,

    maxDrawdown: calculateMaxDrawdown(trades),

    hasEdge: expectancy > 0,

    rating,

    status:
      expectancy > 0
        ? "EDGE"
        : "NO_EDGE",
  };
}

// ═════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════

async function run() {

  const markets =
    await getMarkets();

  if (!markets.length) {

    log("⚠️ No markets");

    return setTimeout(
      run,
      CONFIG.INTERVAL
    );
  }

  await cleanGhostTrades(markets);

  const filtered = markets.filter(m =>

    m.price >= CONFIG.PRICE_MIN &&
    m.price <= CONFIG.PRICE_MAX &&

    m.volume >= CONFIG.MIN_VOLUME &&

    m.liquidity >= CONFIG.MIN_LIQ
  );

  let openMarketCounts = {};

  for (const b of Object.values(state.bots)) {

    for (const t of b.openTrades) {

      openMarketCounts[t.slug] =
        (openMarketCounts[t.slug] || 0) + 1;
    }
  }

  for (const m of filtered) {

    const prev =
      state.marketMemory[m.slug];

    for (const key of Object.keys(BOTS)) {

      const bot =
        state.bots[key];

      // manage
      for (const t of [...bot.openTrades]) {

        if (t.slug === m.slug) {

          manage(bot, t, m.price);
        }
      }

      if (bot.paused) continue;

      if (
        bot.openTrades.length >=
        CONFIG.MAX_OPEN_TRADES
      ) continue;

      if (
        (openMarketCounts[m.slug] || 0) >=
        CONFIG.MAX_POSITIONS_PER_MARKET
      ) continue;

      const s =
        score(m, prev);

      if (
        s < BOTS[key].MIN_SCORE
      ) continue;

      openTrade(bot, m, s);

      openMarketCounts[m.slug] =
        (openMarketCounts[m.slug] || 0) + 1;
    }

    state.marketMemory[m.slug] = {

      price: m.price,

      volume: m.volume,

      timestamp: Date.now(),
    };
  }

  // stats
  for (const key of Object.keys(BOTS)) {

    const bot =
      state.bots[key];

    const eq =
      equity(bot, markets);

    if (eq > bot.peakEquity) {
      bot.peakEquity = eq;
    }

    const dd =
      (bot.peakEquity - eq) /
      bot.peakEquity;

    if (dd > CONFIG.DRAWDOWN_LIMIT) {

      bot.paused = true;

      log(`🛑 ${key} paused by DD`);
    }

    const pnl =
      eq - CONFIG.INITIAL_CAPITAL;

    const openValue =
      eq - bot.cash;

    log(`
📊 BOT ${key}
💵 Cash: $${bot.cash.toFixed(2)}
📦 Open Value: $${openValue.toFixed(2)}
📈 Equity: $${eq.toFixed(2)}
📉 PnL: $${pnl.toFixed(2)}
🔻 DD: ${(dd * 100).toFixed(1)}%
📂 Open Trades: ${bot.openTrades.length}
🧨 Loss Streak: ${bot.consecutiveLosses}
⏸️ Paused: ${bot.paused}
`);
  }

  // analyze
  for (const key of Object.keys(BOTS)) {

    const analysis =
      analyzeBot(state.bots[key]);

    log(`🤖 ${key} ANALYSIS`);

    console.log(analysis);
  }

  saveState();

  setTimeout(
    run,
    CONFIG.INTERVAL
  );
}

// ═════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════

loadState();

log("🚀 BOT STARTED");

run();
