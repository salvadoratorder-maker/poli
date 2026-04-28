import fetch from "node-fetch";

// ═════════ CONFIG ═════════
const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.03,
  MAX_OPEN_TRADES: 3,

  MIN_VOLUME_24H: 500000,
  PRICE_MIN: 0.25,
  PRICE_MAX: 0.75,
  MIN_LIQUIDITY: 50000,

  VOLUME_SPIKE_MULTIPLIER: 2.0,
  PRICE_MOMENTUM_MIN: 0.03,
  LIQUIDITY_DROP_MIN: 0.05,
  MIN_WHALE_SIGNALS: 2, // puedes subir a 3

  STOP_LOSS: 0.12,
  TAKE_PROFIT_PARTIAL: 0.20,
  TRAILING_STOP: 0.065,

  INTERVAL_MS: 60 * 60 * 1000
};

// ═════════ ESTADO ═════════
let capital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let marketMemory = {};
let cycleCount = 0;

// ═════════ UTIL ═════════
const now = () =>
  new Date().toISOString().replace("T", " ").substring(0, 19);

const log = (msg) => console.log(`[${now()}] ${msg}`);

function stats() {
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const total = closedTrades.length;
  const pnl = capital - CONFIG.INITIAL_CAPITAL;
  const roi = ((pnl / CONFIG.INITIAL_CAPITAL) * 100).toFixed(1);

  log(`💰 Capital: ${capital.toFixed(2)} | ROI: ${roi}% | WR: ${wins}/${total}`);
}

// ═════════ API ═════════
async function getMarkets() {
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&limit=30"
    );

    const data = await res.json();

    return data.map(m => {
      let price = 0;
      try {
        const prices = JSON.parse(m.outcomePrices || "[]");
        price = parseFloat(prices[0]) || 0;
      } catch {
        price = parseFloat(m.lastPrice) || 0;
      }

      const volumeTotal = parseFloat(m.volume) || 0;
      const volume24h = parseFloat(m.volume24hr) || 0;

      let volumeAvgDaily = volume24h;
      if (m.startDate && volumeTotal > 0) {
        const days =
          (Date.now() - new Date(m.startDate)) / (1000 * 60 * 60 * 24);
        volumeAvgDaily = volumeTotal / Math.max(1, days);
      }

      return {
        slug: m.slug,
        question: m.question,
        price,
        volume24h,
        volumeAvgDaily,
        liquidity: parseFloat(m.liquidity) || 0,
        endDate: m.endDate
      };
    });
  } catch (e) {
    log("❌ API error");
    return [];
  }
}

// ═════════ WHALES ═════════
function detectWhales(m) {
  const prev = marketMemory[m.slug];
  let signals = 0;

  // volumen
  const volRatio = m.volume24h / (m.volumeAvgDaily || 1);
  if (volRatio >= CONFIG.VOLUME_SPIKE_MULTIPLIER) signals++;

  if (prev) {
    // precio
    const move = (m.price - prev.price) / prev.price;
    if (Math.abs(move) >= CONFIG.PRICE_MOMENTUM_MIN) signals++;

    // liquidez
    const liqDrop = (prev.liquidity - m.liquidity) / prev.liquidity;
    if (liqDrop >= CONFIG.LIQUIDITY_DROP_MIN) signals++;
  }

  return signals;
}

// ═════════ FILTROS ═════════
function isValid(m) {
  if (m.volume24h < CONFIG.MIN_VOLUME_24H) return false;
  if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) return false;
  if (m.liquidity < CONFIG.MIN_LIQUIDITY) return false;
  if (openTrades.find(t => t.slug === m.slug)) return false;

  return true;
}

// ═════════ TRADES ═════════
function openTrade(m) {
  const size = capital * CONFIG.RISK_PER_TRADE;
  if (capital < size) return;

  capital -= size;

  openTrades.push({
    slug: m.slug,
    entry: m.price,
    size,
    peak: m.price,
    partial: false,
    trailing: false
  });

  log(`🟢 OPEN ${m.question}`);
}

function closeTrade(t, price, reason) {
  const value = t.size * (price / t.entry);
  const pnl = value - t.size;

  capital += value;
  closedTrades.push({ pnl });

  openTrades = openTrades.filter(x => x !== t);

  log(`${pnl > 0 ? "💰" : "🛑"} CLOSE ${reason}`);
}

function manage(t, price) {
  const pnl = (price - t.entry) / t.entry;

  if (pnl <= -CONFIG.STOP_LOSS) {
    closeTrade(t, price, "SL");
    return;
  }

  if (pnl >= CONFIG.TAKE_PROFIT_PARTIAL && !t.partial) {
    capital += t.size / 2;
    t.size /= 2;
    t.partial = true;
    t.trailing = true;
    t.peak = price;
    return;
  }

  if (t.trailing) {
    if (price > t.peak) t.peak = price;

    const drop = (t.peak - price) / t.peak;
    if (drop >= CONFIG.TRAILING_STOP) {
      closeTrade(t, price, "TRAIL");
    }
  }
}

// ═════════ MAIN ═════════
async function runBot() {
  cycleCount++;
  log(`════ CICLO ${cycleCount} ════`);

  const markets = await getMarkets();
  if (!markets.length) return;

  // 🧠 PRIMER CICLO NO OPERA
  if (cycleCount === 1) {
    log("🧠 Primer ciclo → solo recolecto datos");
    markets.forEach(m => {
      marketMemory[m.slug] = {
        price: m.price,
        volume24h: m.volume24h,
        liquidity: m.liquidity
      };
    });
    return;
  }

  // gestionar
  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manage(t, m.price);
  }

  // buscar entradas
  for (const m of markets) {
    if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
    if (!isValid(m)) continue;

    const signals = detectWhales(m);

    if (signals >= CONFIG.MIN_WHALE_SIGNALS) {
      openTrade(m);
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

  stats();
}

// start
log("🚀 BOT START");
runBot();
setInterval(runBot, CONFIG.INTERVAL_MS);
