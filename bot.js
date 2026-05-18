// ========================================
// POLYMARKET DRIFT ENGINE v2.0 - BACKTESTABLE
// ========================================

import fs from "fs";
import fetch from "node-fetch";

// CONFIGURACIÓN PRINCIPAL
const CONFIG = {
  API: "https://gamma-api.polymarket.com",
  INITIAL_EQUITY: 200,
  MIN_VOLUME: 30000,
  MIN_LIQ: 10000,
  RISK_PER_TRADE: 0.02,
  FEES: 0.005,
  MAX_OPEN_TRADES: 2,
  HOLD_TIME: 4 * 60 * 60 * 1000, // 4h
  CYCLE_INTERVAL: 60 * 60 * 1000, // 1h
  STOP_LOSS: 0.15,
  TAKE_PROFIT: 0.30,
};

const STATE_FILE = "./bt-state.json";

let state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {
      cycle: 0,
      memory: {}, // market -> array of prices
      positions: [],
      closed: [],
      equity: { A: 200, B: 200, C: 200 },
      peak: { A: 200, B: 200, C: 200 },
      dd: { A: 0, B: 0, C: 0 },
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
// DATOS DE MERCADO
// =====================

async function fetchMarkets() {
  try {
    const response = await fetch(
      `${CONFIG.API}/markets?active=true&closed=false&limit=100`,
      {
        headers: { "User-Agent": "Drift-Engine/2.0" }
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    return data.map(m => ({
      slug: m.slug,
      price: extractPrice(m),
      volume: Number(m.volume24hr || 0),
      liquidity: Number(m.liquidity || 0),
      outcomes: m.outcomes || [],
    }));
  } catch (e) {
    log("FETCH ERROR:" + e.message);
    return [];
  }
}

function extractPrice(m) {
  const p = (m?.outcomePrices?.[0] || m?.lastPrice);
  return p ? parseFloat(p) : 0.5;
}

// =====================
// HISTORIAL DE PRECIOS
// =====================

function updateMarketPrice(slug, price) {
  if (!state.memory[slug]) state.memory[slug] = [];
  state.memory[slug].push(price);
  if (state.memory[slug].length > 60) state.memory[slug].shift(); // Mantenemos 60 timestamps
}

function calculateDrift(slug, lookback = 30) {
  const prices = state.memory[slug];
  if (prices.length < lookback + 1) return 0;
  const start = prices[prices.length - lookback - 1];
  const end = prices[prices.length - 1];
  return (end - start) / start;
}

function calculateVolatility(slug, window = 30) {
  const prices = state.memory[slug];
  if (prices.length < window) return 0.01; // Default small vol
  const returns = [];
  for (let i = 1; i < prices.length && i <= window; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const varRet = returns.map(r => Math.pow(r - meanRet, 2))
    .reduce((a, b) => a + b, 0) / returns.length;
  return Math.sqrt(varRet);
}

// =====================
// FILTRO DE MERCADOS
// =====================

function filterMarkets(markets) {
  const filtered = markets.filter(m => {
    return (
      m.price > 0.001 &&
      m.price < 0.999 &&
      m.volume >= CONFIG.MIN_VOLUME &&
      m.liquidity >= CONFIG.MIN_LIQ
    );
  });
  return filtered;
}

// =====================
// GESTIÓN DE POSICIONES
// =====================

function duplicate(bot, slug) {
  return state.positions.some(p => p.bot === bot && p.slug === slug);
}

function open(bot, market) {
  const botOpen = state.positions.filter(p => p.bot === bot).length;
  if (botOpen >= CONFIG.MAX_OPEN_TRADES) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;
  if (invested <= 0) return;

  state.equity[bot] -= invested;

  state.positions.push({
    bot,
    slug: market.slug,
    entry: market.price,
    invested,
    opened: Date.now(),
    lastUpdate: Date.now(),
  });

  log(`OPEN ${bot} ${market.slug} (p=${market.price.toFixed(3)})`);
}

function close(pos, price) {
  const roi = (price - pos.entry) / pos.entry;
  const grossPnl = pos.invested * roi;
  const netPnl = grossPnl - (pos.invested * CONFIG.FEES);

  state.equity[pos.bot] += pos.invested + netPnl;

  state.closed.push({
    ...pos,
    exit: price,
    pnl: netPnl,
    closeTime: Date.now()
  });

  state.positions = state.positions.filter(p => p !== pos);
  log(`CLOSE ${pos.bot} pnl=${netPnl.toFixed(2)}`);
}

// =====================
// MANEJO DE POSICIONES ABIERTAS
// =====================

function managePositions(markets) {
  const now = Date.now();
  const openPositions = [...state.positions];
  state.positions = [];

  for (const pos of openPositions) {
    const market = markets.find(m => m.slug === pos.slug);
    if (!market) {
      state.positions.push(pos);
      continue;
    }

    const roi = (market.price - pos.entry) / pos.entry;

    if (roi <= -CONFIG.STOP_LOSS || roi >= CONFIG.TAKE_PROFIT || (now - pos.opened > CONFIG.HOLD_TIME)) {
      close(pos, market.price);
    } else {
      pos.lastUpdate = now;
      state.positions.push(pos);
    }
  }
}

// =====================
// SELECCIÓN DE TRADES
// =====================

function selectTrades(markets) {
  const availableMarkets = markets.filter(m => !state.positions.some(p => p.slug === m.slug));
  const activeBots = ["A", "B", "C"];

  for (const bot of activeBots) {
    const candidates = availableMarkets
      .filter(m => {
        const drift = calculateDrift(m.slug);
        const vol = calculateVolatility(m.slug);
        const entry = m.price;
        return Math.abs(drift) > 0.002 && vol > 0.01; // Filtros básicos de drift y vol
      })
      .sort((a, b) => Math.abs(calculateDrift(b.slug)) - Math.abs(calculateDrift(a.slug)));
    
    if (candidates.length > 0) {
      open(bot, candidates[0]);
    }
  }
}

// =====================
// REPORTING
// =====================

function report(stats) {
  const totalTrades = state.closed.length;
  const wins = state.closed.filter(t => t.pnl > 0).length;
  const totalPnl = state.closed.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const avgPnL = totalTrades > 0 ? totalPnl / totalTrades : 0;

  log(`📈 STATS: trades=${totalTrades} WR=${winRate.toFixed(1)}% avgPnL=${avgPnL.toFixed(2)} pnl=${totalPnl.toFixed(2)}`);
  
  for (const b of ["A", "B", "C"]) {
    const pos = state.positions.filter(p => p.bot === b).length;
    log(`${b} eq=${state.equity[b].toFixed(2)} pos=${pos} DD=${(state.dd[b]*100).toFixed(2)}%`);
  }
}

// =====================
// CICLO PRINCIPAL
// =====================

async function cycle() {
  state.cycle++;
  const startTime = Date.now();

  try {
    const rawMarkets = await fetchMarkets();
    const markets = filterMarkets(rawMarkets);

    markets.forEach(m => updateMarketPrice(m.slug, m.price));

    managePositions(markets);

    selectTrades(markets);

    report({
      totalMarkets: rawMarkets.length,
      filtered: markets.length,
      closed: state.closed.length,
    });

    saveState();
    
    const elapsed = Date.now() - startTime;
    if (elapsed > CONFIG.CYCLE_INTERVAL) {
      log(`⚠️ Cycle took ${elapsed}ms (exceeds interval)`);
    }

  } catch (e) {
    log("CYCLE ERROR: " + e.message);
  }

  const next = Math.max(1000, CONFIG.CYCLE_INTERVAL - (Date.now() - startTime));
  setTimeout(cycle, next);
}

// =====================
// INICIÓN DEL BOT
// =====================

log("🚀 DRIFT ENGINE v2.0 - START");
log("Config: Cycle every " + (CONFIG.CYCLE_INTERVAL / 1000) + "s Max trades: " + CONFIG.MAX_OPEN_TRADES);
cycle();

process.on('uncaughtException', (err) => {
  log("UNCAUGHT EXCEPTION: " + err.message);
  saveState();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log("UNHANDLED REJECTION: " + reason);
  saveState();
});
