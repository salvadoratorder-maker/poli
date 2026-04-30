import fetch from "node-fetch";
import fs from "fs";

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,

  MIN_VOLUME_24H: 300000,   // más suave
  PRICE_MIN: 0.20,
  PRICE_MAX: 0.80,
  MIN_LIQUIDITY: 50000,

  VOLUME_SPIKE_MULTIPLIER: 1.5, // más suave
  PRICE_MOMENTUM_MIN: 0.02,
  LIQUIDITY_DROP_MIN: 0.03,
  MIN_WHALE_SIGNALS: 1, // más entradas

  STOP_LOSS: 0.10,
  TAKE_PROFIT_PARTIAL: 0.15,
  TRAILING_STOP: 0.05,

  MAX_DRAWDOWN: 0.30,
  FEES: 0.005, // 0.5%

  INTERVAL_MS: 60 * 60 * 1000,
};

// ═══════════════════════════════════════
// ESTADO (persistente)
// ═══════════════════════════════════════

let capital = CONFIG.INITIAL_CAPITAL;
let peakCapital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let marketMemory = {};
let apiFails = 0;
let cycle = 0;

// Cargar estado si existe
if (fs.existsSync("state.json")) {
  const saved = JSON.parse(fs.readFileSync("state.json"));
  capital = saved.capital;
  openTrades = saved.openTrades;
  marketMemory = saved.marketMemory;
}

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════

const now = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const log = (msg) => console.log(`[${now()}] ${msg}`);

// ═══════════════════════════════════════
// GUARDAR ESTADO
// ═══════════════════════════════════════

function saveState() {
  fs.writeFileSync(
    "state.json",
    JSON.stringify({ capital, openTrades, marketMemory }, null, 2)
  );
}

// ═══════════════════════════════════════
// CSV
// ═══════════════════════════════════════

function saveTrade(t) {
  const file = "trades.csv";

  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      "open,close,entry,exit,pnl,reason,signals\n"
    );
  }

  const line = [
    t.openDate,
    t.exitDate,
    t.entry,
    t.exitPrice,
    t.pnl.toFixed(2),
    t.reason,
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
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30"
    );

    if (!res.ok) throw new Error("API fail");

    const data = await res.json();
    apiFails = 0;

    return data.map((m) => {
      let price = 0;
      try {
        const p = JSON.parse(m.outcomePrices || "[]");
        price = p[0] || m.lastPrice;
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
  } catch (e) {
    apiFails++;
    log("❌ API ERROR");

    if (apiFails >= 3) {
      log("🛑 TOO MANY FAILS — STOP");
      process.exit(1);
    }

    return [];
  }
}

// ═══════════════════════════════════════
// WHALES
// ═══════════════════════════════════════

function detectWhales(m, prev) {
  if (!prev) return { ok: false, signals: 0 };

  let s = 0;

  if (m.volume24h > prev.volume24h * CONFIG.VOLUME_SPIKE_MULTIPLIER) s++;

  const move = (m.price - prev.price) / prev.price;
  if (Math.abs(move) > CONFIG.PRICE_MOMENTUM_MIN) s++;

  if (prev.liquidity > m.liquidity * (1 + CONFIG.LIQUIDITY_DROP_MIN)) s++;

  return { ok: s >= CONFIG.MIN_WHALE_SIGNALS, signals: s };
}

// ═══════════════════════════════════════
// RIESGO REAL
// ═══════════════════════════════════════

function positionSize(price) {
  const equity = getEquity();
  const risk = equity * CONFIG.RISK_PER_TRADE;
  const stopDist = price * CONFIG.STOP_LOSS;

  let size = risk / stopDist;

  // limitar tamaño
  size = Math.min(size, equity * 0.1);

  return Math.max(1, size);
}

function getEquity() {
  let eq = capital;

  for (const t of openTrades) {
    eq += t.size;
  }

  return eq;
}

// ═══════════════════════════════════════
// TRADES
// ═══════════════════════════════════════

function openTrade(m, signals) {
  const size = positionSize(m.price);
  if (capital < size) return;

  capital -= size;

  openTrades.push({
    slug: m.slug,
    question: m.question,
    entry: m.price,
    size,
    peak: m.price,
    partial: false,
    openDate: now(),
    whaleSignals: signals,
  });

  log(`🟢 OPEN ${m.question} @ ${m.price}`);
}

function closeTrade(t, price, reason) {
  const gross = t.size * (price / t.entry);
  const fees = gross * CONFIG.FEES;
  const pnl = gross - t.size - fees;

  capital += gross - fees;

  const closed = {
    ...t,
    exitPrice: price,
    exitDate: now(),
    pnl,
    reason,
  };

  saveTrade(closed);
  closedTrades.push(closed);

  openTrades = openTrades.filter((x) => x !== t);

  log(`🔴 CLOSE ${reason} | PnL ${pnl.toFixed(2)}`);
}

// ═══════════════════════════════════════
// GESTIÓN
// ═══════════════════════════════════════

function manageTrade(t, price) {
  const pnlPct = (price - t.entry) / t.entry;

  if (pnlPct <= -CONFIG.STOP_LOSS) {
    closeTrade(t, price, "STOP");
    return;
  }

  if (pnlPct >= CONFIG.TAKE_PROFIT_PARTIAL && !t.partial) {
    const half = t.size / 2;
    capital += half;
    t.size /= 2;
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
// RIESGO GLOBAL
// ═══════════════════════════════════════

function riskControl() {
  const eq = getEquity();

  if (eq > peakCapital) peakCapital = eq;

  const dd = (peakCapital - eq) / peakCapital;

  if (dd > CONFIG.MAX_DRAWDOWN) {
    log("🛑 MAX DD STOP");
    process.exit(1);
  }
}

// ═══════════════════════════════════════
// LOOP
// ═══════════════════════════════════════

async function run() {
  cycle++;
  log(`════ CICLO ${cycle} ════`);

  const markets = await getMarkets();
  if (!markets.length) return next();

  // snapshot anterior
  const prevMemory = { ...marketMemory };

  // gestionar trades
  for (const t of [...openTrades]) {
    const m = markets.find((x) => x.slug === t.slug);
    if (m) manageTrade(t, m.price);
  }

  // entradas
  if (openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    for (const m of markets) {
      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;

      if (
        m.volume24h < CONFIG.MIN_VOLUME_24H ||
        m.price < CONFIG.PRICE_MIN ||
        m.price > CONFIG.PRICE_MAX ||
        m.liquidity < CONFIG.MIN_LIQUIDITY
      )
        continue;

      if (openTrades.find((t) => t.slug === m.slug)) continue;

      const whale = detectWhales(m, prevMemory[m.slug]);

      if (!whale.ok) continue;

      openTrade(m, whale.signals);
    }
  }

  // actualizar memoria DESPUÉS
  markets.forEach((m) => {
    marketMemory[m.slug] = {
      price: m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
    };
  });

  riskControl();
  saveState();

  log(`💰 Capital: ${capital.toFixed(2)} | Trades: ${openTrades.length}`);

  next();
}

function next() {
  setTimeout(run, CONFIG.INTERVAL_MS);
}

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

log("🚀 BOT FINAL PRO (estable)");
run();
