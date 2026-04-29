import fetch from "node-fetch";
import fs from "fs";

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 2,

  MIN_VOLUME_24H: 500000,
  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,
  MIN_LIQUIDITY: 75000,

  VOLUME_SPIKE_MULTIPLIER: 2.0,
  PRICE_MOMENTUM_MIN: 0.04,
  LIQUIDITY_DROP_MIN: 0.05,
  MIN_WHALE_SIGNALS: 2,

  STOP_LOSS: 0.10,
  TAKE_PROFIT_PARTIAL: 0.15,
  TRAILING_STOP: 0.05,

  MAX_DRAWDOWN: 0.25,

  INTERVAL_MS: 60 * 60 * 1000,
};

// ═══════════════════════════════════════
// ESTADO
// ═══════════════════════════════════════

let capital = CONFIG.INITIAL_CAPITAL;
let peakCapital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let marketMemory = {};
let cycle = 0;

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (msg) => console.log(`[${now()}] ${msg}`);

// ═══════════════════════════════════════
// CSV PRO
// ═══════════════════════════════════════

function saveTrade(trade) {
  const duration = (new Date(trade.exitDate) - new Date(trade.openDate)) / 1000;

  const line = [
    trade.openDate,
    trade.exitDate,
    duration,
    trade.entry,
    trade.exitPrice,
    trade.pnl,
    trade.reason,
    trade.whaleSignals ?? 0,
    trade.slug ?? ""
  ].join(",");

  if (!fs.existsSync("trades.csv")) {
    fs.writeFileSync(
      "trades.csv",
      "open,close,duration_sec,entry,exit,pnl,reason,signals,market\n"
    );
  }

  fs.appendFileSync("trades.csv", line + "\n");
}

// ═══════════════════════════════════════
// API
// ═══════════════════════════════════════

async function getMarkets() {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&limit=30");
    const data = await res.json();

    return data.map(m => {
      let price = 0;
      try {
        price = JSON.parse(m.outcomePrices || "[]")[0];
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
    });

  } catch {
    log("❌ Error API");
    return [];
  }
}

// ═══════════════════════════════════════
// FILTROS
// ═══════════════════════════════════════

function isValid(m) {
  if (m.volume24h < CONFIG.MIN_VOLUME_24H) return false;
  if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) return false;
  if (m.liquidity < CONFIG.MIN_LIQUIDITY) return false;
  if (openTrades.find(t => t.slug === m.slug)) return false;

  // evitar mercados muertos
  const prev = marketMemory[m.slug];
  if (prev) {
    const move = Math.abs((m.price - prev.price) / prev.price);
    if (move < 0.01) return false;
  }

  return true;
}

// ═══════════════════════════════════════
// DETECTOR WHALES
// ═══════════════════════════════════════

function detectWhales(m) {
  const prev = marketMemory[m.slug];
  if (!prev) return { ok: false, signals: 0 };

  let signals = 0;

  if (m.volume24h > prev.volume24h * CONFIG.VOLUME_SPIKE_MULTIPLIER) signals++;

  const move = (m.price - prev.price) / prev.price;
  if (Math.abs(move) > CONFIG.PRICE_MOMENTUM_MIN) signals++;

  if (prev.liquidity > m.liquidity * (1 + CONFIG.LIQUIDITY_DROP_MIN)) signals++;

  return { ok: signals >= CONFIG.MIN_WHALE_SIGNALS, signals };
}

// ═══════════════════════════════════════
// TRADING
// ═══════════════════════════════════════

function size() {
  return +(capital * CONFIG.RISK_PER_TRADE).toFixed(2);
}

function openTrade(m, whaleSignals) {
  const s = size();
  if (capital < s) return;

  capital -= s;

  openTrades.push({
    slug: m.slug,
    question: m.question,
    entry: m.price,
    size: s,
    peak: m.price,
    partial: false,
    openDate: now(),
    whaleSignals
  });

  log(`🟢 OPEN ${m.question} @ ${m.price}`);
}

function closeTrade(t, price, reason) {
  const value = t.size * (price / t.entry);
  const pnl = value - t.size;

  capital += value;

  const closed = {
    ...t,
    exitPrice: price,
    exitDate: now(),
    pnl,
    reason
  };

  closedTrades.push(closed);
  saveTrade(closed);

  log(`🔴 CLOSE ${reason} | PnL: ${pnl.toFixed(2)}`);

  openTrades = openTrades.filter(x => x !== t);
}

function manage(t, price) {
  const pnl = (price - t.entry) / t.entry;

  if (pnl <= -CONFIG.STOP_LOSS) {
    closeTrade(t, price, "STOP");
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
    closeTrade(t, price, "TRAIL");
  }
}

// ═══════════════════════════════════════
// AUTO AJUSTE
// ═══════════════════════════════════════

function autoAdjust() {
  if (closedTrades.length < 20) return;

  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const winrate = wins / closedTrades.length;

  log(`🧠 WR: ${(winrate * 100).toFixed(0)}%`);

  if (winrate < 0.4) {
    CONFIG.RISK_PER_TRADE = Math.max(0.01, CONFIG.RISK_PER_TRADE - 0.005);
    CONFIG.MIN_WHALE_SIGNALS = Math.min(3, CONFIG.MIN_WHALE_SIGNALS + 1);
    log("⚠ Modo defensivo");
  }

  if (winrate > 0.6) {
    CONFIG.RISK_PER_TRADE = Math.min(0.03, CONFIG.RISK_PER_TRADE + 0.005);
    CONFIG.MIN_WHALE_SIGNALS = Math.max(1, CONFIG.MIN_WHALE_SIGNALS - 1);
    log("🚀 Modo agresivo");
  }
}

// ═══════════════════════════════════════
// RIESGO GLOBAL
// ═══════════════════════════════════════

function riskControl() {
  if (capital > peakCapital) peakCapital = capital;

  const dd = (peakCapital - capital) / peakCapital;

  if (dd >= CONFIG.MAX_DRAWDOWN) {
    log("🛑 MAX DRAWDOWN alcanzado — BOT PARADO");
    process.exit();
  }
}

// ═══════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════

async function run() {
  cycle++;
  log(`════ CICLO ${cycle} ════`);

  const markets = await getMarkets();
  if (!markets.length) return;

  // gestionar trades
  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manage(t, m.price);
  }

  // nuevas entradas
  if (openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    for (const m of markets) {
      if (!isValid(m)) continue;

      const whale = detectWhales(m);
      if (!whale.ok) continue;

      openTrade(m, whale.signals);

      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
    }
  }

  // guardar memoria
  markets.forEach(m => {
    marketMemory[m.slug] = {
      price: m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity
    };
  });

  autoAdjust();
  riskControl();

  log(`💰 Capital: ${capital.toFixed(2)} | Trades abiertos: ${openTrades.length}\n`);
}

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

log("🚀 BOT PRO ACTIVO");
run();
setInterval(run, CONFIG.INTERVAL_MS);
