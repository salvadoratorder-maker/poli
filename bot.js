// ========================================
// POLYMARKET MICRODRIFT v4.3
// Enhanced Paper Trading / Multi-Bot / Persistent
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
  FEES: 0.005,  // 0.5% (realista)

  MAX_OPEN_TRADES: 2,
  MAX_POSITIONS_PER_MARKET: 1,

  HOLD_TIME: 60 * 60 * 1000,
  CYCLE_INTERVAL: 5 * 60 * 1000,

  STOP_LOSS: 0.15,
  TAKE_PROFIT: 0.30,
};

const BOTS = {
  A: { MIN_SCORE: 0.10, BALANCE: 200 },
  B: { MIN_SCORE: 0.14, BALANCE: 200 },
  C: { MIN_SCORE: 0.12, BALANCE: 200 }
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
          "User-Agent": "Microdrift-Bot/4.3"
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
    if (m.outcomePrices && m.outcomePrices.length > 0) {
      const priceArray = JSON.parse(m.outcomePrices);
      return Number(priceArray[0] || 0.5);
    }
    return Number(m.lastPrice || 0.5);
  } catch (e) {
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
    // Filtrado para evitar mercados resueltos
    if (m.price > 0.001 && m.price < 0.999) {
      state.memory[m.slug] = m.price;
    }
  }
}

// =====================
// SCORE
// =====================

function score(m) {
  const mv = move(m.slug, m.price);
  
  // Enhanced scoring algorithm
  let s = 0;
  
  // Price movement signal (more weight to significant moves)
  if (Math.abs(mv) > 0.005) {
    s += Math.min(0.5, Math.abs(mv) * 100);
  } else if (Math.abs(mv) > 0.001) {
    s += Math.min(0.3, Math.abs(mv) * 50);
  }
  
  // Volume normalization
  const volNorm = Math.min(1, m.volume / 500000);
  s += volNorm * 0.3;
  
  // Distance from center (0.5) - penalize extreme prices
  const dist = Math.abs(m.price - 0.5);
  s += (1 - dist * 2) * 0.2;
  
  // Penalize extreme prices
  if (dist > 0.35) {
    s -= 0.2;
  }
  
  // Add liquidity factor
  const liqNorm = Math.min(1, m.liquidity / 100000);
  s += liqNorm * 0.15;
  
  return Math.max(0, Math.min(1, s));
}

// =====================
// FILTERS
// =====================

function filter(markets) {
  let rej = { p: 0, v: 0, l: 0 };
  let validMarkets = [];

  for (const m of markets) {
    // Filtro para evitar mercados resueltos o extraños
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

function duplicate(slug) {
  return state.positions.filter(p => p.slug === slug).length >=
    CONFIG.MAX_POSITIONS_PER_MARKET;
}

function open(bot, m) {
  if (duplicate(m.slug)) return;

  const botOpen = state.positions.filter(p => p.bot === bot).length;

  if (botOpen >= CONFIG.MAX_OPEN_TRADES) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;

  // Check if we have enough funds
  if (invested <= 0) {
    log(`NOT ENOUGH FUNDS FOR ${bot} to open position`);
    return;
  }

  state.positions.push({
    bot,
    slug: m.slug,
    entry: m.price,
    invested,
    opened: Date.now(),
    lastUpdate: Date.now()
  });

  log(`OPEN ${bot} ${m.slug} ${m.price.toFixed(3)} score=${score(m).toFixed(2)}`);
}

function close(pos, px) {
  const grossPnl = pos.invested * ((px - pos.entry) / pos.entry);
  const netPnl = grossPnl - (pos.invested * CONFIG.FEES);

  state.equity[pos.bot] += netPnl;

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

    // Update lastUpdate time for tracking
    p.lastUpdate = now;
    
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
    log(`${b} eq=${state.equity[b].toFixed(2)} pos=${pos}`);
  }

  const totalTrades = state.closed.length;
  const wins = state.closed.filter(t => t.pnl > 0).length;
  const totalPnl = state.closed.reduce((s, t) => s + t.pnl, 0);

  log(
    `STATS trades=${totalTrades} WR=${
      totalTrades
        ? ((wins / totalTrades) * 100).toFixed(1)
        : 0
    }% pnl=${totalPnl.toFixed(2)}`
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

    // Improved trading logic to ensure better opportunities
    for (const bot of ["A", "B", "C"]) {
      // Prioritize by score and available funds
      const eligibleMarkets = scoredMarkets
        .filter(m => m.score >= BOTS[bot].MIN_SCORE && 
                    state.equity[bot] > 0)
        .sort((a, b) => b.score - a.score);

      if (eligibleMarkets.length > 0) {
        const candidate = eligibleMarkets[0];
        open(bot, candidate);
      }
    }

    report(markets.length, filtered, rej);

    updateMemory(markets);

    saveState();
    
    // Log performance
    const elapsed = Date.now() - startTime;
    if (elapsed > CONFIG.CYCLE_INTERVAL) {
      log(`⚠️ Cycle took ${elapsed}ms (exceeds interval)`);
    }
    
  } catch (error) {
    log(`CYCLE ERROR: ${error.message}`);
  }

  // Ensure interval is maintained even if processing takes time
  const nextCycleTime = CONFIG.CYCLE_INTERVAL - (Date.now() - startTime);
  setTimeout(cycle, Math.max(1000, nextCycleTime));
}

// =====================
// START
// =====================

log("🚀 MICRODRIFT v4.3 - STARTING...");
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
