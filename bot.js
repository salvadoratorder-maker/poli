// ========================================
// POLYMARKET MICRODRIFT v4 STABLE
// Paper trading / multi-bot / persistent
// ========================================

import fs from "fs";
import fetch from "node-fetch";

// ========================================
// CONFIG
// ========================================

const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  PRICE_MIN: 0.18,
  PRICE_MAX: 0.82,

  MIN_VOLUME: 50000,
  MIN_LIQ: 25000,

  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 2,
  MAX_POSITIONS_PER_MARKET: 1,

  HOLD_TIME: 60 * 60 * 1000,
  INTERVAL: 5 * 60 * 1000,

  STOP_LOSS: 0.15,
  TAKE_PROFIT: 0.30,

  FEES: 0.02,

  STATE_FILE: "state.json"
};

const BOTS = {
  A: { MIN_SCORE: 0.10 },
  B: { MIN_SCORE: 0.14 },
  C: { MIN_SCORE: 0.18 }
};

// ========================================
// STATE
// ========================================

let state = {
  cycle: 0,
  equity: { A: 200, B: 200, C: 200 },
  positions: [],
  closed: [],
  memory: {},
  rejects: { price: 0, volume: 0, liq: 0 }
};

// ========================================
// UTILS
// ========================================

const ts = () => new Date().toISOString();

function log(m) {
  console.log(`[${ts()}] ${m}`);
}

function save() {
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

function load() {
  try {
    state = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE));
    log("STATE LOADED");
  } catch {
    log("NEW STATE");
  }
}

// ========================================
// FETCH
// ========================================

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
      liq: Number(m.liquidity || 0)
    }));

  } catch (e) {
    log(`FETCH ERROR ${e.message}`);
    return [];
  }
}

function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");
    const p = raw.map(Number).filter(x => x > 0 && x < 1);
    return p[0] || Number(m.lastPrice || 0.5);
  } catch {
    return Number(m.lastPrice || 0.5);
  }
}

// ========================================
// MEMORY
// ========================================

function move(slug, px) {
  const prev = state.memory[slug];
  state.memory[slug] = px;

  if (!prev) return 0;

  return px - prev;
}

// ========================================
// SCORE
// ========================================

function score(m) {
  const mv = move(m.slug, m.price);

  const volNorm = Math.min(1, m.volume / 500000);
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (mv > 0.001) s += 0.35;
  else if (mv > 0.0003) s += 0.20;
  else if (mv < -0.001) s += 0.25;

  s += volNorm * 0.25;
  s += (1 - dist * 2) * 0.15;

  if (dist > 0.35) s -= 0.20;

  return Math.max(0, Math.min(1, s));
}

// ========================================
// FILTER
// ========================================

function filter(markets) {
  state.rejects = { price: 0, volume: 0, liq: 0 };

  return markets.filter(m => {
    if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) {
      state.rejects.price++;
      return false;
    }

    if (m.volume < CONFIG.MIN_VOLUME) {
      state.rejects.volume++;
      return false;
    }

    if (m.liq < CONFIG.MIN_LIQ) {
      state.rejects.liq++;
      return false;
    }

    return true;
  });
}

// ========================================
// POSITIONS
// ========================================

function duplicate(slug) {
  return state.positions.filter(p => p.slug === slug).length >=
    CONFIG.MAX_POSITIONS_PER_MARKET;
}

function open(bot, m) {
  if (duplicate(m.slug)) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;

  state.positions.push({
    bot,
    slug: m.slug,
    entry: m.price,
    invested,
    opened: Date.now()
  });

  log(`OPEN ${bot} ${m.slug} @${m.price.toFixed(3)}`);
}

function close(pos, px) {
  const pnl =
    pos.invested * ((px - pos.entry) / pos.entry) -
    pos.invested * CONFIG.FEES;

  state.equity[pos.bot] += pnl;

  state.closed.push({
    ...pos,
    exit: px,
    pnl
  });

  state.positions = state.positions.filter(p => p !== pos);

  log(`CLOSE ${pos.bot} pnl=${pnl.toFixed(2)}`);
}

// ========================================
// MANAGE
// ========================================

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

// ========================================
// REPORT
// ========================================

function report(markets, filtered) {
  log(
    `CYCLE ${state.cycle} ` +
    `markets=${markets.length} ` +
    `filtered=${filtered.length} ` +
    `open=${state.positions.length} ` +
    `rej[p:${state.rejects.price}|v:${state.rejects.volume}|l:${state.rejects.liq}]`
  );

  for (const b of ["A", "B", "C"]) {
    const trades = state.closed.filter(x => x.bot === b);

    log(
      `${b} eq=${state.equity[b].toFixed(2)} trades=${trades.length}`
    );
  }
}

// ========================================
// LOOP
// ========================================

async function cycle() {
  state.cycle++;

  const markets = await fetchMarkets();
  const filtered = filter(markets);

  manage(markets);

  for (const bot of ["A", "B", "C"]) {
    const candidates = filtered
      .map(m => ({ ...m, s: score(m) }))
      .filter(m => m.s >= BOTS[bot].MIN_SCORE)
      .sort((a, b) => b.s - a.s);

    if (candidates[0]) open(bot, candidates[0]);
  }

  report(markets, filtered);

  save();

  setTimeout(cycle, CONFIG.INTERVAL);
}

// ========================================
// START
// ========================================

load();

log("MICRODRIFT v4 START");

cycle();
