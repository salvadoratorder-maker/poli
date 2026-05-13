
import fs from "fs";
import fetch from "node-fetch";

const INSTANCE_ID = process.env.INSTANCE_ID || "main";
const STATE_FILE = `state.${INSTANCE_ID}.json`;

const CONFIG = {
  INITIAL_CAPITAL: 200,

  RISK_PER_TRADE: 0.02,
  FEES: 0.02,

  INTERVAL: 5 * 60 * 1000,

  MAX_OPEN_TRADES: 2,
  MAX_POSITIONS_PER_MARKET: 1,

  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,

  MIN_VOLUME: 120000,
  MIN_LIQ: 40000,

  STOP_LOSS: 0.07,
  TAKE_PROFIT: 0.10,

  MAX_CONSECUTIVE_LOSSES: 3,
  DRAWDOWN_LIMIT: 0.15
};

const BOTS = {
  A: { MIN_SCORE: 0.15 },
  B: { MIN_SCORE: 0.20 },
  C: { MIN_SCORE: 0.25 }
};

let state = {
  bots: {},
  marketMemory: {}
};

function freshBot() {
  return {
    cash: CONFIG.INITIAL_CAPITAL,
    openTrades: [],
    closedTrades: [],
    paused: false,
    consecutiveLosses: 0,
    peakEquity: CONFIG.INITIAL_CAPITAL,
    stats: {}
  };
}

for (const k of Object.keys(BOTS)) {
  state.bots[k] = freshBot();
}

function ts() {
  return new Date().toISOString();
}

function log(m) {
  console.log(`[${INSTANCE_ID}] ${ts()} ${m}`);
}

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE));

    for (const k of Object.keys(BOTS)) {
      if (!state.bots[k]) state.bots[k] = freshBot();
    }

    cleanGhostTrades();

    log("STATE LOADED");
  } catch {
    log("NEW STATE");
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanGhostTrades() {
  for (const bot of Object.values(state.bots)) {
    const seen = new Set();

    bot.openTrades = bot.openTrades.filter(t => {
      if (!t.slug || !t.entry || !t.shares) return false;

      const id = `${t.slug}_${t.entry}_${t.shares}`;

      if (seen.has(id)) return false;

      seen.add(id);
      return true;
    });
  }
}

function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");

    const valid = raw
      .map(Number)
      .filter(x => !isNaN(x) && x > 0 && x < 1);

    if (valid.length) return valid[0];
  } catch {}

  return Number(m.lastPrice) || 0;
}

async function getMarkets() {
  const r = await fetch(
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30"
  );

  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const d = await r.json();

  return d.map(m => ({
    slug: m.slug,
    price: extractPrice(m),
    volume: +m.volume24hr || 0,
    liquidity: +m.liquidity || 0
  }));
}

function score(m, p) {
  if (!p || p.price <= 0) return 0;

  const age = Date.now() - p.timestamp;

  if (age > 4 * CONFIG.INTERVAL) return 0;

  const move = (m.price - p.price) / p.price;
  const vol = p.volume > 0 ? m.volume / p.volume : 1;
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (move > 0.002 && move <= 0.05) s += 0.35;
  if (vol > 1.15) s += 0.20;
  if (move > 0 && m.price < 0.70) s += 0.15;
  if (dist > 0.20) s -= 0.15;
  if (move > 0.08) s -= 0.10;

  return Math.max(0, Math.min(1, s));
}

function marketPositions(slug) {
  let count = 0;

  for (const bot of Object.values(state.bots)) {
    count += bot.openTrades.filter(t => t.slug === slug).length;
  }

  return count;
}

function equity(bot, markets) {
  let eq = bot.cash;

  for (const t of bot.openTrades) {
    const m = markets.find(x => x.slug === t.slug);

    if (m) eq += t.shares * m.price;
  }

  return eq;
}

function updateStats(bot) {
  const t = bot.closedTrades;

  if (!t.length) return;

  const wins = t.filter(x => x.pnl > 0);
  const losses = t.filter(x => x.pnl <= 0);

  const avgWin =
    wins.reduce((a, b) => a + b.pnl, 0) /
    (wins.length || 1);

  const avgLoss =
    Math.abs(
      losses.reduce((a, b) => a + b.pnl, 0)
    ) / (losses.length || 1);

  const wr = wins.length / t.length;

  const expectancy =
    wr * avgWin -
    (1 - wr) * avgLoss;

  const pf =
    avgLoss > 0
      ? (wr * avgWin) /
        ((1 - wr) * avgLoss)
      : Infinity;

  const breakevenWR =
    avgWin + avgLoss > 0
      ? avgLoss / (avgWin + avgLoss)
      : 0;

  bot.stats = {
    trades: t.length,
    avgWin,
    avgLoss,
    winrate: wr,
    expectancy,
    profitFactor: pf,
    breakevenWR
  };
}

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
    openedAt: ts()
  });

  log(`OPEN ${m.slug} score=${s.toFixed(2)}`);
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
    closedAt: ts()
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

  updateStats(bot);

  log(`CLOSE ${reason} pnl=${pnl.toFixed(2)}`);
}

function manage(bot, t, price) {
  const move =
    (price - t.entry) / t.entry;

  if (move <= -CONFIG.STOP_LOSS)
    return closeTrade(bot, t, price, "SL");

  if (move >= CONFIG.TAKE_PROFIT)
    return closeTrade(bot, t, price, "TP");
}

async function run() {
  try {
    const markets = await getMarkets();

    let rejects = {
      price: 0,
      volume: 0,
      liq: 0
    };

    const filtered = markets.filter(m => {
      if (
        m.price < CONFIG.PRICE_MIN ||
        m.price > CONFIG.PRICE_MAX
      ) {
        rejects.price++;
        return false;
      }

      if (m.volume < CONFIG.MIN_VOLUME) {
        rejects.volume++;
        return false;
      }

      if (
        m.liquidity < CONFIG.MIN_LIQ
      ) {
        rejects.liq++;
        return false;
      }

      return true;
    });

    let opens = 0;

    for (const m of filtered) {
      const prev =
        state.marketMemory[m.slug];

      for (const k of Object.keys(BOTS)) {
        const bot =
          state.bots[k];

        for (const t of [
          ...bot.openTrades
        ]) {
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
          marketPositions(m.slug) >=
          CONFIG.MAX_POSITIONS_PER_MARKET
        )
          continue;

        const s =
          score(m, prev);

        if (
          s <
          BOTS[k].MIN_SCORE
        )
          continue;

        openTrade(bot, m, s);
        opens++;
      }

      state.marketMemory[m.slug] = {
        price: m.price,
        volume: m.volume,
        timestamp: Date.now()
      };
    }

    for (const k of Object.keys(BOTS)) {
      const bot =
        state.bots[k];

      const eq =
        equity(bot, markets);

      if (
        eq > bot.peakEquity
      )
        bot.peakEquity = eq;

      const dd =
        (bot.peakEquity - eq) /
        bot.peakEquity;

      if (
        dd >
        CONFIG.DRAWDOWN_LIMIT
      )
        bot.paused = true;

      log(
        `${k} cash=${bot.cash.toFixed(
          2
        )} eq=${eq.toFixed(
          2
        )} trades=${
          bot.closedTrades.length
        }`
      );
    }

    const pfA =
      state.bots.A.stats
        .profitFactor
        ?.toFixed(2) ||
      "N/A";

    log(
      `CYCLE markets=${markets.length} filtered=${filtered.length} opens=${opens} rej[p:${rejects.price}|v:${rejects.volume}|l:${rejects.liq}] PF_A=${pfA}`
    );

    saveState();
  } catch (e) {
    log(`ERR ${e.message}`);
  }

  setTimeout(
    run,
    CONFIG.INTERVAL
  );
}

loadState();
run();
