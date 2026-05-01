import fetch from "node-fetch";
import fs from "fs";

// ═══════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MIN_VOLUME_24H: 300000,
  PRICE_MIN: 0.20,
  PRICE_MAX: 0.80,
  MIN_LIQUIDITY: 50000,
  PRICE_MOMENTUM_MIN: 0.02,
  VOLUME_SPIKE_MULTIPLIER: 1.5,
  LIQUIDITY_DROP_MIN: 0.03,
  MIN_SCORE: 40,
  STOP_LOSS: 0.10,
  TAKE_PROFIT_PARTIAL: 0.15,
  TRAILING_STOP: 0.05,
  MAX_DRAWDOWN: 0.30,
  MAX_HOLD_DAYS: 7,
  FEE: 0.005,
  INTERVAL_MS: 60 * 60 * 1000,
};

// ═══════════════════════════════════════
// ESTADO Y PERSISTENCIA
// ═══════════════════════════════════════

let capital = CONFIG.INITIAL_CAPITAL;
let peakEquity = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let marketMemory = {};
let apiFails = 0;
let isPaused = false;

function saveState() {
  try {
    fs.writeFileSync("state.json", JSON.stringify({ capital, peakEquity, openTrades, marketMemory }, null, 2));
  } catch (err) { console.error("❌ Error guardando estado:", err.message); }
}

function loadState() {
  try {
    if (fs.existsSync("state.json")) {
      const s = JSON.parse(fs.readFileSync("state.json"));
      capital = s.capital || CONFIG.INITIAL_CAPITAL;
      peakEquity = s.peakEquity || CONFIG.INITIAL_CAPITAL;
      openTrades = s.openTrades || [];
      marketMemory = s.marketMemory || {};
    }
  } catch (err) { console.log("⚠️ No se pudo cargar estado, iniciando limpio."); }
}

const now = () => new Date().toISOString();
const log = (msg) => console.log(`[${now()}] ${msg}`);

// ═══════════════════════════════════════
// API Y CÁLCULOS
// ═══════════════════════════════════════

async function getMarkets() {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30");
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    apiFails = 0;
    return data.map((m) => ({
      slug: m.slug,
      price: parseFloat(JSON.parse(m.outcomePrices || "[]")[0] || m.lastPrice) || 0,
      volume24h: parseFloat(m.volume24hr) || 0,
      liquidity: parseFloat(m.liquidity) || 0,
    }));
  } catch (err) {
    apiFails++;
    if (apiFails >= 3) process.exit(1);
    return [];
  }
}

function getEquity(markets) {
  let equity = capital;
  for (const t of openTrades) {
    const m = markets.find((x) => x.slug === t.slug);
    equity += m ? (t.size * (m.price / t.entry)) : t.size;
  }
  return equity;
}

function positionSize(price) {
  const size = Math.min((capital * CONFIG.RISK_PER_TRADE) / (price * CONFIG.STOP_LOSS), capital * 0.1);
  return Math.max(1, size);
}

// ═══════════════════════════════════════
// LÓGICA DE TRADING
// ═══════════════════════════════════════

function openTrade(m, score) {
  const size = positionSize(m.price);
  if (capital < size) return;
  capital -= size;
  openTrades.push({ slug: m.slug, entry: m.price, size, peak: m.price, openDate: now(), score, partial: false });
  log(`🟢 OPEN ${m.slug} @ ${m.price.toFixed(3)} | score ${score}`);
}

function closeTrade(t, price, reason) {
  const net = (t.size * (price / t.entry)) * (1 - CONFIG.FEE);
  capital += net;
  log(`🔴 CLOSE ${reason} | PnL ${(net - t.size).toFixed(2)}`);
  openTrades = openTrades.filter((x) => x !== t);
}

function manageTrade(t, price) {
  const pnlPct = (price - t.entry) / t.entry;

  if (pnlPct <= -CONFIG.STOP_LOSS) return closeTrade(t, price, "STOP");
  if ((Date.now() - new Date(t.openDate)) / 86400000 > CONFIG.MAX_HOLD_DAYS) return closeTrade(t, price, "TIMEOUT");

  if (pnlPct >= CONFIG.TAKE_PROFIT_PARTIAL && !t.partial) {
    const half = t.size * 0.5;
    capital += (half * (price / t.entry)) * (1 - CONFIG.FEE);
    t.size -= half;
    t.partial = true;
    t.peak = price;
    log(`✂️ PARTIAL sold @ ${price.toFixed(3)}`);
    return;
  }

  if (price > t.peak) t.peak = price;
  if ((t.peak - price) / t.peak >= CONFIG.TRAILING_STOP) closeTrade(t, price, "TRAIL");
}

// ═══════════════════════════════════════
// BUCLE PRINCIPAL
// ═══════════════════════════════════════

async function run() {
  log("════ NUEVO CICLO ════");
  const markets = await getMarkets();
  if (!markets.length) return setTimeout(run, CONFIG.INTERVAL_MS);

  const prevMemory = { ...marketMemory };

  for (const t of openTrades.slice()) {
    const m = markets.find((x) => x.slug === t.slug);
    if (m) manageTrade(t, m.price);
  }

  if (!isPaused && openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    for (const m of markets) {
      if (openTrades.find((t) => t.slug === m.slug)) continue;
      const prev = prevMemory[m.slug];
      if (!prev || m.volume24h < prev.volume24h * 0.8 || m.volume24h < CONFIG.MIN_VOLUME_24H) continue;

      let score = ((Math.abs((m.price - prev.price) / prev.price) > CONFIG.PRICE_MOMENTUM_MIN) ? 30 : 0) +
                  ((m.volume24h > prev.volume24h * CONFIG.VOLUME_SPIKE_MULTIPLIER) ? 30 : 0) +
                  ((prev.liquidity > m.liquidity * (1 + CONFIG.LIQUIDITY_DROP_MIN)) ? 40 : 0);

      if (score >= CONFIG.MIN_SCORE) openTrade(m, score);
    }
  }

  markets.forEach((m) => marketMemory[m.slug] = { price: m.price, volume24h: m.volume24h, liquidity: m.liquidity });

  const equity = getEquity(markets);
  if (equity > peakEquity) peakEquity = equity;
  const dd = (peakEquity - equity) / peakEquity;

  log(`💰 Equity: ${equity.toFixed(2)} | DD: ${(dd * 100).toFixed(1)}%`);
  if (dd > CONFIG.MAX_DRAWDOWN) { isPaused = true; log("🛑 PAUSA POR DRAWDOWN"); }

  saveState();
  setTimeout(run, CONFIG.INTERVAL_MS);
}

loadState();
log("🚀 BOT FINAL PRO READY");
run();
