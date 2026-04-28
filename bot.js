import fetch from "node-fetch";

// ================= CONFIG =================
const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.03,
  MAX_OPEN_TRADES: 3,

  MIN_VOLUME: 10000,
  PRICE_MIN: 0.2,
  PRICE_MAX: 0.8,

  STOP_LOSS: 0.12,
  TAKE_PROFIT_PARTIAL: 0.2,
  TRAILING_STOP: 0.05
};

// ================= STATE =================
let capital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];

// ================= API REAL (POLYMARKET) =================
async function getMarkets() {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets");
    const data = await res.json();

    return data.slice(0, 20).map(m => ({
      id: m.id,
      price: parseFloat(m.lastPrice) || 0,
      volume24h: parseFloat(m.volume24hr) || 0
    }));
  } catch (err) {
    console.log("❌ Error API:", err);
    return [];
  }
}

// ================= FILTROS =================
function isValidMarket(market) {
  return (
    market.volume24h >= CONFIG.MIN_VOLUME &&
    market.price >= CONFIG.PRICE_MIN &&
    market.price <= CONFIG.PRICE_MAX
  );
}

// ================= TRADING =================
function getPositionSize() {
  return capital * CONFIG.RISK_PER_TRADE;
}

function openTrade(market) {
  const size = getPositionSize();

  if (capital < size) return;

  capital -= size;

  openTrades.push({
    marketId: market.id,
    entry: market.price,
    size,
    partialClosed: false,
    trailingActive: false,
    peak: market.price
  });

  console.log("🟢 OPEN", market.id, "price:", market.price, "size:", size.toFixed(2));
}

function closeTrade(trade, price) {
  const value = trade.size * (price / trade.entry);
  capital += value;

  console.log("🔴 CLOSE", trade.marketId, "PnL:", (value - trade.size).toFixed(2));

  openTrades = openTrades.filter(t => t !== trade);
}

function closePartial(trade, price) {
  const half = trade.size * 0.5;
  const value = half * (price / trade.entry);

  capital += value;
  trade.size -= half;

  console.log("🟡 PARTIAL", trade.marketId);
}

function manageTrade(trade, currentPrice) {
  const pnl = (currentPrice - trade.entry) / trade.entry;

  if (pnl <= -CONFIG.STOP_LOSS) {
    closeTrade(trade, currentPrice);
    return;
  }

  if (pnl >= CONFIG.TAKE_PROFIT_PARTIAL && !trade.partialClosed) {
    closePartial(trade, currentPrice);
    trade.partialClosed = true;
    trade.trailingActive = true;
    trade.peak = currentPrice;
  }

  if (trade.trailingActive) {
    if (currentPrice > trade.peak) {
      trade.peak = currentPrice;
    }

    const drop = (trade.peak - currentPrice) / trade.peak;

    if (drop >= CONFIG.TRAILING_STOP) {
      closeTrade(trade, currentPrice);
    }
  }
}

// ================= MAIN LOOP =================
async function runBot() {
  const markets = await getMarkets();

  if (!markets.length) return;

  // abrir trades
  for (const market of markets) {
    if (
      isValidMarket(market) &&
      openTrades.length < CONFIG.MAX_OPEN_TRADES
    ) {
      openTrade(market);
    }
  }

  // gestionar trades
  for (const trade of [...openTrades]) {
    const market = markets.find(m => m.id === trade.marketId);
    if (market) {
      manageTrade(trade, market.price);
    }
  }

  console.log("💰 CAPITAL:", capital.toFixed(2));
}

// ejecutar cada 10s
setInterval(runBot, 10000);
