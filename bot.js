
import fs from "fs";
import fetch from "node-fetch";

const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  INITIAL_EQUITY: 200,

  PRICE_MIN: 0.18,
  PRICE_MAX: 0.82,

  MIN_VOLUME: 50000,
  MIN_LIQ: 25000,

  RISK_PER_TRADE: 0.02,
  FEES: 0.02,

  MAX_OPEN_TRADES: 2,
  MAX_POSITIONS_PER_MARKET: 1,

  HOLD_TIME: 60 * 60 * 1000,
  CYCLE_INTERVAL: 5 * 60 * 1000,

  STOP_LOSS: 0.15,
  TAKE_PROFIT: 0.30,
};

const BOTS = {
  A: { MIN_SCORE: 0.10 },
  B: { MIN_SCORE: 0.14 },
  C: { MIN_SCORE: 0.18 }
};

const STATE_FILE = "./state.json";

let state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE));
  } catch {
    return {
      cycle: 0,
      memory: {},
      positions: [],
      closed: [],
      equity: { A: 200, B: 200, C: 200 }
    };
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// =====================
// API
// =====================

async function fetchMarkets() {
  try {
    const r = await fetch(
      `${CONFIG.API}/markets?active=true&closed=false&limit=100`
    );

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const d = await r.json();

    return d.map(m => ({
      slug: m.slug,
      price: extractPrice(m),
      volume: Number(m.volume24hr || 0),
      liquidity: Number(m.liquidity || 0)
    }));
  } catch (e) {
    log(`FETCH ERROR ${e.message}`);
    return [];
  }
}

function extractPrice(m) {
  try {
    const p = JSON.parse(m.outcomePrices || "[]");
    return Number(p[0] || m.lastPrice || 0.5);
  } catch {
    return Number(m.lastPrice || 0.5);
  }
}

// =====================
// MEMORY
// =====================

function move(slug, px) {
  const prev = state.memory[slug];
  if (prev === undefined) return 0;
  return px - prev;
}

function updateMemory(markets) {
  for (const m of markets) {
    state.memory[m.slug] = m.price;
  }
}

// =====================
// SCORE
// =====================

function score(m) {
  const mv = move(m.slug, m.price);

  const volNorm = Math.min(1, m.volume / 500000);
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (mv > 0.001) s += 0.35;
  else if (mv > 0.0003) s += 0.20;
  else if (mv < -0.001) s += 0.35;
  else if (mv < -0.0003) s += 0.20;

  s += volNorm * 0.25;
  s += (1 - dist * 2) * 0.15;

  if (dist > 0.35) s -= 0.20;

  return Math.max(0, Math.min(1, s));
}

// =====================
// FILTERS
// =====================

function filter(markets) {
  let rej = { p: 0, v: 0, l: 0 };

  const out = markets.filter(m => {
    if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) {
      rej.p++;
      return false;
    }

    if (m.volume < CONFIG.MIN_VOLUME) {
      rej.v++;
      return false;
    }

    if (m.liquidity < CONFIG.MIN_LIQ) {
      rej.l++;
      return false;
    }

    return true;
  });

  return { out, rej };
}

// =====================
// POSITIONS
// =====================

function duplicate(slug) {
  return state.positions.filter(p => p.slug === slug).length >=
    CONFIG.MAX_POSITIONS_PER_MARKET;
}

function open(bot, m) {
  if (duplicate(m.slug)) return;

  const botOpen = state.positions.filter(p => p.bot === bot).length;

  if (botOpen >= CONFIG.MAX_OPEN_TRADES) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;

  state.positions.push({
    bot,
    slug: m.slug,
    entry: m.price,
    invested,
    opened: Date.now()
  });

  log(`OPEN ${bot} ${m.slug} ${m.price.toFixed(3)}`);
}

function close(pos, px) {
  const grossPnl =
    pos.invested * ((px - pos.entry) / pos.entry);

  const netPnl =
    grossPnl - (pos.invested * CONFIG.FEES);

  state.equity[pos.bot] += netPnl;

  state.closed.push({
    ...pos,
    exit: px,
    pnl: netPnl
  });

  state.positions =
    state.positions.filter(p => p !== pos);

  log(
    `CLOSE ${pos.bot} pnl=${netPnl.toFixed(2)}`
  );
}

// =====================
// MANAGEMENT
// =====================

function manage(markets) {
  const now = Date.now();

  for (const p of [...state.positions]) {
    const m = markets.find(x => x.slug === p.slug);
    if (!m) continue;

    const roi = (m.price - p.entry) / p.entry;

    if (roi <= -CONFIG.STOP_LOSS) {
      close(p, m.price);
      continue;
    }

    if (roi >= CONFIG.TAKE_PROFIT) {
      close(p, m.price);
      continue;
    }

    if (now - p.opened > CONFIG.HOLD_TIME) {
      close(p, m.price);
    }
  }
}

// =====================
// REPORT
// =====================

function report(markets, filtered, rej) {
  log(
    `CYCLE ${state.cycle} markets=${markets.length} filtered=${filtered.length} open=${state.positions.length} rej[p:${rej.p}|v:${rej.v}|l:${rej.l}]`
  );

  for (const bot of ["A", "B", "C"]) {
    const pos = state.positions.filter(p => p.bot === bot).length;
    log(`${bot} eq=${state.equity[bot].toFixed(2)} pos=${pos}`);
  }

  const totalTrades = state.closed.length;
  const wins = state.closed.filter(t => t.pnl > 0).length;
  const totalPnl = state.closed.reduce((s, t) => s + t.pnl, 0);

  log(
    `TOTAL trades=${totalTrades} WR=${
      totalTrades ? ((wins / totalTrades) * 100).toFixed(1) : "0"
    }% pnl=${totalPnl.toFixed(2)}`
  );
}

// =====================
// LOOP
// =====================

async function cycle() {
  state.cycle++;

  const markets = await fetchMarkets();

  const { out: filtered, rej } = filter(markets);

  manage(markets);

  const scoredMarkets = filtered.map(m => ({
    ...m,
    score: score(m)
  }));

  for (const bot of ["A", "B", "C"]) {
    const candidate = scoredMarkets
      .filter(m => m.score >= BOTS[bot].MIN_SCORE)
      .sort((a, b) => b.score - a.score)[0];

    if (candidate) {
      open(bot, candidate);
    }
  }

  report(markets, filtered, rej);

  updateMemory(markets);

  saveState();

  setTimeout(cycle, CONFIG.CYCLE_INTERVAL);
}

// =====================
// START
// =====================

log("MICRODRIFT v4.2 START");
cycle();
