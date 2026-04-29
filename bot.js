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

  VOLUME_SPIKE_MULTIPLIER: 1.8,
  PRICE_MOMENTUM_MIN: 0.03,
  LIQUIDITY_DROP_MIN: 0.04,
  MIN_WHALE_SIGNALS: 2,

  STOP_LOSS: 0.10,
  TAKE_PROFIT_PARTIAL: 0.15,
  TRAILING_STOP: 0.05,

  MAX_DRAWDOWN: 0.25,

  COOLDOWN_AFTER_LOSSES: 3,
  COOLDOWN_CYCLES: 3,

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
let lossStreak = 0;
let cooldown = 0;

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════

const now = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const log = (msg) => console.log(`[${now()}] ${msg}`);

// ═══════════════════════════════════════
// CSV
// ═══════════════════════════════════════

function saveTrade(trade) {
  const file = "trades.csv";

  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      "open,close,entry,exit,pnl,reason,signals\n"
    );
  }

  const line = [
    trade.openDate,
    trade.exitDate,
    trade.entry,
    trade.exitPrice,
    trade.pnl,
    trade.reason,
    trade.whaleSignals ?? 0,
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
// FILTRO BASE
// ═══════════════════════════════════════

function isValid(m) {
  if (m.volume24h < CONFIG.MIN_VOLUME_24H) return false;
  if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) return false;
  if (m.liquidity < CONFIG.MIN_LIQUIDITY) return false;
  if (openTrades.find(t => t.slug === m.slug)) return false;

  const prev = marketMemory[m.slug];
  if (!prev) return false;

  // 🔥 SOLO TENDENCIA ALCISTA
  const move = (m.price - prev.price) / prev.price;
  if (move < CONFIG.PRICE_MOMENTUM_MIN) return false;

  return true;
}

// ═══════════════════════════════════════
// WHALES
// ═══════════════════════════════════════

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
    openDate: now(),
  });

  log(`🟢 OPEN ${m.question} @ ${m.price}`);
}

function closeTrade(t, price, reason) {
  const value = t.size * (price / t.entry);
  const pnl = value - t.size;

  capital += value;

  const trade = {
    ...t,
    exitPrice: price,
    exitDate: now(),
    pnl,
    reason,
  };

  closedTrades.push(trade);
  saveTrade(trade);

  if (pnl < 0) lossStreak++;
  else lossStreak = 0;

  log(`🔴 CLOSE ${reason} PnL: ${pnl.toFixed(2)}`);

  openTrades = openTrades.filter(x => x !== t);
}

function manageTrade(t, price) {
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
// RIESGO GLOBAL
// ═══════════════════════════════════════

function riskControl() {
  if (capital > peakCapital) peakCapital = capital;

  const dd = (peakCapital - capital) / peakCapital;

  if (dd >= CONFIG.MAX_DRAWDOWN) {
    log("🛑 STOP TOTAL (drawdown)");
    process.exit(1);
  }
}

// ═══════════════════════════════════════
// LOOP
// ═══════════════════════════════════════

async function run() {
  cycle++;
  log(`═══ CICLO ${cycle} | Capital ${capital.toFixed(2)} ═══`);

  const markets = await getMarkets();
  if (!markets.length) return;

  // gestionar trades
  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manageTrade(t, m.price);
  }

  // cooldown
  if (lossStreak >= CONFIG.COOLDOWN_AFTER_LOSSES) {
    cooldown = CONFIG.COOLDOWN_CYCLES;
    lossStreak = 0;
    log("⏸ COOLDOWN ACTIVADO");
  }

  if (cooldown > 0) {
    cooldown--;
    log(`⏸ En cooldown (${cooldown})`);
  } else {
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
  }

  // ⚠️ GUARDAR MEMORIA AL FINAL (FIX CLAVE)
  markets.forEach(m => {
    marketMemory[m.slug] = {
      price: m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
    };
  });

  riskControl();

  log(`📊 Capital: ${capital.toFixed(2)} | Trades: ${openTrades.length}`);
  log("══════════════════════════════════════\n");
}

// START
log("🚀 BOT ELITE ACTIVO");
run();
setInterval(run, CONFIG.INTERVAL_MS);
