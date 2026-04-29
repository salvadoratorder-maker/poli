import fetch from "node-fetch";
import fs from "fs";

// ═══════════════════════════════════════
// CONFIG BASE (el bot la modificará solo)
// ═══════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 2,

  MIN_VOLUME_24H: 500000,
  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,
  MIN_LIQUIDITY: 75000,

  VOLUME_SPIKE_MULTIPLIER: 1.8,
  PRICE_MOMENTUM_MIN: 0.03,
  LIQUIDITY_DROP_MIN: 0.04,
  MIN_WHALE_SIGNALS: 2,

  STOP_LOSS: 0.10,
  TAKE_PROFIT_PARTIAL: 0.15,
  TRAILING_STOP: 0.05,

  MAX_DRAWDOWN: 0.25,

  INTERVAL_MS: 60 * 60 * 1000,
};

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════

let capital = CONFIG.INITIAL_CAPITAL;
let peakCapital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let marketMemory = {};

let cycle = 0;
let tradesThisCycle = 0;

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════

const now = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const log = (msg) => console.log(`[${now()}] ${msg}`);

// ═══════════════════════════════════════
// CSV
// ═══════════════════════════════════════

function saveTrade(t) {
  const file = "trades.csv";

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "entry,exit,pnl,signals\n");
  }

  const line = [
    t.entry,
    t.exitPrice,
    t.pnl,
    t.whaleSignals ?? 0,
  ].join(",");

  fs.appendFileSync(file, line + "\n");
}

// ═══════════════════════════════════════
// API
// ═══════════════════════════════════════

async function getMarkets() {
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&limit=30"
    );

    const data = await res.json();

    return data.map((m) => {
      let price = 0;
      try {
        const prices = JSON.parse(m.outcomePrices || "[]");
        price = prices[0] || m.lastPrice;
      } catch {
        price = m.lastPrice;
      }

      return {
        slug: m.slug,
        question: (m.question || "").slice(0, 60),
        price: parseFloat(price) || 0,
        volume24h: parseFloat(m.volume24hr) || 0,
        liquidity: parseFloat(m.liquidity) || 0,
      };
    }).filter(m => m.price > 0);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════
// FILTRO + WHALES
// ═══════════════════════════════════════

function isValid(m) {
  if (m.volume24h < CONFIG.MIN_VOLUME_24H) return false;
  if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) return false;
  if (m.liquidity < CONFIG.MIN_LIQUIDITY) return false;

  const prev = marketMemory[m.slug];
  if (!prev) return false;

  const move = (m.price - prev.price) / prev.price;
  if (move < CONFIG.PRICE_MOMENTUM_MIN) return false;

  return true;
}

function detectWhales(m) {
  const prev = marketMemory[m.slug];
  if (!prev) return { ok: false, signals: 0 };

  let s = 0;

  if (m.volume24h > prev.volume24h * CONFIG.VOLUME_SPIKE_MULTIPLIER) s++;

  const move = (m.price - prev.price) / prev.price;
  if (move > CONFIG.PRICE_MOMENTUM_MIN) s++;

  if (prev.liquidity > m.liquidity * (1 + CONFIG.LIQUIDITY_DROP_MIN)) s++;

  return { ok: s >= CONFIG.MIN_WHALE_SIGNALS, signals: s };
}

// ═══════════════════════════════════════
// TRADE
// ═══════════════════════════════════════

function size() {
  return Math.max(0.01, +(capital * CONFIG.RISK_PER_TRADE).toFixed(2));
}

function openTrade(m, signals) {
  const s = size();
  if (capital < s) return;

  capital -= s;

  openTrades.push({
    slug: m.slug,
    entry: m.price,
    size: s,
    peak: m.price,
    partial: false,
    whaleSignals: signals,
  });

  tradesThisCycle++;

  log(`🟢 OPEN ${m.question}`);
}

function closeTrade(t, price) {
  const value = t.size * (price / t.entry);
  const pnl = value - t.size;

  capital += value;

  closedTrades.push({ ...t, exitPrice: price, pnl });
  saveTrade({ ...t, exitPrice: price, pnl });

  openTrades = openTrades.filter(x => x !== t);
}

function manageTrade(t, price) {
  const pnl = (price - t.entry) / t.entry;

  if (pnl <= -CONFIG.STOP_LOSS) {
    closeTrade(t, price);
    return;
  }

  if (pnl >= CONFIG.TAKE_PROFIT_PARTIAL && !t.partial) {
    capital += t.size * 0.5 * (price / t.entry);
    t.size *= 0.5;
    t.partial = true;
    t.peak = price;
    return;
  }

  if (price > t.peak) t.peak = price;

  const drop = (t.peak - price) / t.peak;
  if (drop >= CONFIG.TRAILING_STOP) {
    closeTrade(t, price);
  }
}

// ═══════════════════════════════════════
// 🧠 AUTO ADAPTACIÓN (LA CLAVE)
// ═══════════════════════════════════════

function adapt() {
  if (closedTrades.length < 10) return;

  const last10 = closedTrades.slice(-10);
  const wins = last10.filter(t => t.pnl > 0).length;
  const winrate = wins / last10.length;

  log(`🧠 Adaptando... Winrate: ${(winrate * 100).toFixed(0)}%`);

  // 🔴 MAL → más estricto
  if (winrate < 0.4) {
    CONFIG.MIN_WHALE_SIGNALS = Math.min(3, CONFIG.MIN_WHALE_SIGNALS + 1);
    CONFIG.RISK_PER_TRADE = Math.max(0.01, CONFIG.RISK_PER_TRADE - 0.005);
    log("⚠ Modo DEFENSIVO");
  }

  // 🟢 BIEN → más agresivo
  if (winrate > 0.6) {
    CONFIG.MIN_WHALE_SIGNALS = Math.max(1, CONFIG.MIN_WHALE_SIGNALS - 1);
    CONFIG.RISK_PER_TRADE = Math.min(0.03, CONFIG.RISK_PER_TRADE + 0.005);
    log("🚀 Modo AGRESIVO");
  }

  // 🟡 NO OPERA → relajar filtros
  if (tradesThisCycle === 0) {
    CONFIG.VOLUME_SPIKE_MULTIPLIER = Math.max(1.3, CONFIG.VOLUME_SPIKE_MULTIPLIER - 0.1);
    CONFIG.PRICE_MOMENTUM_MIN = Math.max(0.015, CONFIG.PRICE_MOMENTUM_MIN - 0.005);
    log("🟡 Relajando filtros (no trades)");
  }

  tradesThisCycle = 0;
}

// ═══════════════════════════════════════
// LOOP
// ═══════════════════════════════════════

async function run() {
  cycle++;
  log(`═══ CICLO ${cycle} | Capital ${capital.toFixed(2)} ═══`);

  const markets = await getMarkets();
  if (!markets.length) return;

  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manageTrade(t, m.price);
  }

  if (openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    for (const m of markets) {
      if (!isValid(m)) continue;

      const whale = detectWhales(m);
      if (!whale.ok) continue;

      openTrade(m, whale.signals);

      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
    }
  }

  // guardar memoria (correcto)
  markets.forEach(m => {
    marketMemory[m.slug] = {
      price: m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
    };
  });

  adapt();

  log(`📊 Capital: ${capital.toFixed(2)} | Trades: ${openTrades.length}`);
  log("══════════════════════════════════════\n");
}

// START
log("🚀 BOT AUTO-ADAPTATIVO ACTIVO");
run();
setInterval(run, CONFIG.INTERVAL_MS);
