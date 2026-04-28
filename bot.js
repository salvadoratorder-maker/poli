// ================= CONFIG PRO =================
const CONFIG = {
  INITIAL_CAPITAL: 200,

  RISK_PER_TRADE: 0.03,
  MAX_OPEN_TRADES: 2,

  MIN_VOLUME: 500000,
  PRICE_MIN: 0.35,
  PRICE_MAX: 0.85,

  MIN_WHALES: 6,
  TOP_TRADERS: 20,

  STOP_LOSS: 0.12,
  TAKE_PROFIT_PARTIAL: 0.20,
  TRAILING_STOP: 0.05,

  MIN_SCORE: 8
};

// ================= STATE =================
let capital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let priceHistory = {};

let lastTradeTime = 0;
const COOLDOWN = 30000;

let lossStreak = 0;
const MAX_LOSSES = 2;

// ================= MOCK DATA =================
function getMarkets() {
  return [
    { id: 1, price: Math.random() * 0.2 + 0.4, volume24h: 800000 },
    { id: 2, price: Math.random() * 0.2 + 0.4, volume24h: 200000 },
  ];
}

function getTraders() {
  return Array.from({ length: 20 }).map((_, i) => ({
    id: i,
    positions: [1]
  }));
}

// ================= HELPERS =================
function updatePriceHistory(market) {
  if (!priceHistory[market.id]) {
    priceHistory[market.id] = [];
  }

  priceHistory[market.id].push(market.price);

  if (priceHistory[market.id].length > 10) {
    priceHistory[market.id].shift();
  }
}

function getTrend(marketId) {
  const history = priceHistory[marketId];
  if (!history || history.length < 5) return 0;

  const start = history[0];
  const end = history[history.length - 1];

  return (end - start) / start;
}

function getMomentum(marketId) {
  const history = priceHistory[marketId];
  if (!history || history.length < 3) return 0;

  const prev = history[history.length - 3];
  const current = history[history.length - 1];

  return (current - prev) / prev;
}

function hasConsensus(traders, marketId) {
  const top = traders.slice(0, CONFIG.TOP_TRADERS);
  let count = 0;

  for (const trader of top) {
    if (trader.positions.includes(marketId)) {
      count++;
    }
  }

  return count;
}

// ================= SCORE =================
function calculateScore(market, traders) {
  let score = 0;

  if (market.volume24h >= CONFIG.MIN_VOLUME) score += 2;

  if (
    market.price >= CONFIG.PRICE_MIN &&
    market.price <= CONFIG.PRICE_MAX
  ) score += 1;

  const whales = hasConsensus(traders, market.id);
  if (whales >= CONFIG.MIN_WHALES) score += 2;

  const trend = getTrend(market.id);
  if (trend > 0.02) score += 3;

  const momentum = getMomentum(market.id);
  if (momentum > 0.01) score += 3;

  return score;
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

  console.log("🟢 OPEN:", market.id, "size:", size.toFixed(2));
}

function closeTrade(trade, price) {
  const value = trade.size * (price / trade.entry);
  capital += value;

  const pnl = (price - trade.entry) / trade.entry;

  if (pnl < 0) {
    lossStreak++;
  } else {
    lossStreak = 0;
  }

  console.log("🔴 CLOSE:", trade.marketId, "capital:", capital.toFixed(2), "lossStreak:", lossStreak);

  openTrades = openTrades.filter(t => t !== trade);
}

function closePartial(trade, price) {
  const half = trade.size * 0.5;
  const value = half * (price / trade.entry);

  capital += value;
  trade.size -= half;

  console.log("🟡 PARTIAL:", trade.marketId);
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

// ================= MAIN =================
function runBot() {
  const markets = getMarkets();
  const traders = getTraders();
  const now = Date.now();

  for (const market of markets) {
    updatePriceHistory(market);

    const score = calculateScore(market, traders);

    if (
      score >= CONFIG.MIN_SCORE &&
      openTrades.length < CONFIG.MAX_OPEN_TRADES &&
      !openTrades.find(t => t.marketId === market.id) &&
      now - lastTradeTime > COOLDOWN &&
      lossStreak < MAX_LOSSES
    ) {
      console.log("✅ SCORE OK:", market.id, "score:", score);
      openTrade(market);
      lastTradeTime = now;
    }
  }

  for (const trade of [...openTrades]) {
    const market = markets.find(m => m.id === trade.marketId);
    if (market) {
      manageTrade(trade, market.price);
    }
  }

  console.log("💰 CAPITAL:", capital.toFixed(2));
}

setInterval(runBot, 5000);
