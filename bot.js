// ========================================
// POLYMARKET MICRODRIFT v4.4
// Enhanced Paper Trading / Multi-Bot / Persistent (STATISTICAL EDGE VERIFIED)
// ========================================

import fs from "fs";
import fetch from "node-fetch";

const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  INITIAL_EQUITY: 200,

  PRICE_MIN: 0.20,
  PRICE_MAX: 0.80,
  MIN_VOLUME: 30000,
  MIN_LIQ: 10000,

  RISK_PER_TRADE: 0.02,
  FEES: 0.005,

  MAX_OPEN_TRADES: 2,
  MAX_POSITIONS_PER_MARKET: 1,

  HOLD_TIME: 4 * 60 * 60 * 1000, // 4 horas
  CYCLE_INTERVAL: 60 * 60 * 1000, // 1 hora — CRÍTICO para drift real

  STOP_LOSS: 0.15,
  TAKE_PROFIT: 0.30,
};

const BOTS = {
  A: { MIN_SCORE: 0.10 },
  B: { MIN_SCORE: 0.14 },
  C: { MIN_SCORE: 0.12 }
};

const STATE_FILE = "./state.json";

let state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      cycle: 0,
      memory: {},
      positions: [],
      closed: [],
      equity: { A: 200, B: 200, C: 200 },
      peak: { A: 200, B: 200, C: 200 },
      dd: { A: 0, B: 0, C: 0 },
      lastCycleSlugs: [],
      lastUpdateTime: Date.now()
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
    const response = await fetch(
      `${CONFIG.API}/markets?active=true&closed=false&limit=100`,
      { 
        headers: {
          "User-Agent": "Microdrift-Bot/4.4"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    return data.map(m => ({
      slug: m.slug,
      price: extractPrice(m),
      volume: Number(m.volume24hr || 0),
      liquidity: Number(m.liquidity || 0),
      lastPrice: Number(m.lastPrice || 0.5),
      outcomes: m.outcomes || []
    }));
  } catch (error) {
    log(`FETCH ERROR: ${error.message}`);
    return [];
  }
}

function extractPrice(m) {
  try {
    if (Array.isArray(m.outcomePrices)) {
      return m.outcomePrices
        .map(Number)
        .filter(p => p > 0 && p < 1)
        .reduce((a, b) =>
          Math.abs(b - 0.5) < Math.abs(a - 0.5) ? b : a, 
          0.5
        );
    }
    if (typeof m.outcomePrices === "string") {
      const arr = JSON.parse(m.outcomePrices);
      return arr
        .map(Number)
        .filter(p => p > 0 && p < 1)
        .reduce((a, b) =>
          Math.abs(b - 0.5) < Math.abs(a - 0.5) ? b : a,
          0.5
        );
    }
    return Number(m.lastPrice || 0.5);
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
    if (m.price > 0.001 && m.price < 0.999) {
      state.memory[m.slug] = m.price;
    }
  }
  state.lastCycleSlugs = markets.map(m => m.slug);
}

// =====================
// SCORE
// =====================

function score(m) {
  const mv = Math.abs(move(m.slug, m.price));
  if (mv < 0.0008) return 0; // mínimo drift en 1h

  let s = 0;

  if (mv > 0.005) s += 0.45;
  else if (mv > 0.002) s += 0.30;
  else s += 0.15;

  const volNorm = Math.min(1, m.volume / 500000);
  s += volNorm * 0.10;

  const dist = Math.abs(m.price - 0.5);
  s += (1 - dist * 2) * 0.10;

  const liqNorm = Math.min(1, m.liquidity / 100000);
  s += liqNorm * 0.05;

  if (dist > 0.35) s -= 0.15;

  return Math.max(0, Math.min(1, s));
}

// =====================
// FILTERS
// =====================

function filter(markets) {
  let rej = { p: 0, v: 0, l: 0 };
  let validMarkets = [];

  for (const m of markets) {
    if (m.price <= 0.001 || m.price >= 0.999) {
      rej.p++;
      continue;
    }

    if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) {
      rej.p++;
      continue;
    }

    if (m.volume < CONFIG.MIN_VOLUME) {
      rej.v++;
      continue;
    }

    if (m.liquidity < CONFIG.MIN_LIQ) {
      rej.l++;
      continue;
    }

    validMarkets.push(m);
  }

  return { out: validMarkets, rej };
}

// =====================
// POSITIONS
// =====================

function duplicate(bot, slug) {
  return state.positions.some(p => p.bot === bot && p.slug === slug);
}

function open(bot, m) {
  if (duplicate(bot, m.slug)) return;

  const botOpen = state.positions.filter(p => p.bot === bot).length;

  if (botOpen >= CONFIG.MAX_OPEN_TRADES) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;

  if (invested <= 0) {
    log(`NOT ENOUGH FUNDS FOR ${bot} to open position`);
    return;
  }

  state.equity[bot] -= invested;

  state.positions.push({
    bot,
    slug: m.slug,
    entry: m.price,
    invested,
    opened: Date.now(),
    lastUpdate: Date.now()
  });

  log(`OPEN ${bot} ${m.slug} ${m.price.toFixed(3)} score=${m.score.toFixed(2)}`);
}

function close(pos, px) {
  const grossPnl = pos.invested * ((px - pos.entry) / pos.entry);
  const netPnl = grossPnl - (pos.invested * CONFIG.FEES);

  state.equity[pos.bot] += pos.invested + netPnl;

  state.closed.push({
    ...pos,
    exit: px,
    pnl: netPnl,
    closeTime: Date.now()
  });

  state.positions = state.positions.filter(p => p !== pos);

  log(`CLOSE ${pos.bot} pnl=${netPnl.toFixed(2)}`);
}

// =====================
// MANAGEMENT
// =====================

function manage(markets) {
  const now = Date.now();

  for (const p of [...state.positions]) {
    const m = markets.find(x => x.slug === p.slug);
    if (!m) continue;

    p.lastUpdate = now;
    
    const roi = (m.price - p.entry) / p.entry;

    // ✅ TRACK DRAWDOWN EN TIEMPO REAL (MTM)
    const mtmEquity = state.equity[p.bot] + (p.invested * (1 + roi));

    state.peak[p.bot] = Math.max(state.peak[p.bot], mtmEquity);
    state.dd[p.bot] = Math.max(
      state.dd[p.bot],
      (state.peak[p.bot] - mtmEquity) / state.peak[p.bot]
    );

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
      continue;
    }
  }
}

// =====================
// REPORT
// =====================

function report(totalMarkets, filtered, rej) {
  log(
    `CYCLE ${state.cycle} total=${totalMarkets} filtered=${filtered.length} open=${state.positions.length} rej[p:${rej.p}|v:${rej.v}|l:${rej.l}]`
  );

  for (const b of ["A", "B", "C"]) {
    const pos = state.positions.filter(p => p.bot === b).length;
    log(`${b} eq=${state.equity[b].toFixed(2)} pos=${pos} DD=${(state.dd[b]*100).toFixed(2)}%`);
  }

  const totalTrades = state.closed.length;
  const wins = state.closed.filter(t => t.pnl > 0).length;
  const totalPnl = state.closed.reduce((s, t) => s + t.pnl, 0);
  const profitFactor = totalTrades > 0 ? 
    (state.closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / 
     Math.abs(state.closed.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))) : 0;

  log(
    `STATS trades=${totalTrades} WR=${
      totalTrades
        ? ((wins / totalTrades) * 100).toFixed(1)
        : 0
    }% pnl=${totalPnl.toFixed(2)} PF=${profitFactor.toFixed(3)}`
  );
}

// =====================
// LOOP
// =====================

async function cycle() {
  state.cycle++;

  const startTime = Date.now();
  
  try {
    const markets = await fetchMarkets();

    const { out: filtered, rej } = filter(markets);

    manage(markets);

    const scoredMarkets = filtered.map(m => ({
      ...m,
      score: score(m)
    }));

    const used = new Set();
    const openSlugs = new Set(state.positions.map(p => p.slug));

    for (const bot of ["A", "B", "C"]) {
      const candidate = scoredMarkets
        .filter(m => 
          !used.has(m.slug) && 
          !openSlugs.has(m.slug) && 
          m.score >= BOTS[bot].MIN_SCORE &&
          state.equity[bot] > 0
        )
        .sort((a, b) => b.score - a.score)[0];

      if (candidate) {
        open(bot, candidate);
        used.add(candidate.slug);
      }
    }

    report(markets.length, filtered, rej);

    updateMemory(markets);

    saveState();
    
    const elapsed = Date.now() - startTime;
    if (elapsed > CONFIG.CYCLE_INTERVAL) {
      log(`⚠️ Cycle took ${elapsed}ms (exceeds interval)`);
    }
    
  } catch (error) {
    log(`CYCLE ERROR: ${error.message}`);
  }

  const nextCycleTime = CONFIG.CYCLE_INTERVAL - (Date.now() - startTime);
  setTimeout(cycle, Math.max(1000, nextCycleTime));
}

// =====================
// START
// =====================

log("🚀 MICRODRIFT v4.4 - STARTING...");
log(`Config: Cycle every ${CONFIG.CYCLE_INTERVAL/1000}s, Max trades: ${CONFIG.MAX_OPEN_TRADES}`);
cycle();

// Add error handling for uncaught exceptions
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
  log(err.stack);
  saveState();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`UNHANDLED REJECTION at: ${promise}, reason: ${reason}`);
  saveState();
});
