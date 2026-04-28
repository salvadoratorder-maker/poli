const axios = require('axios');
const fs = require('fs');

// ================= CONFIG PRO =================
const CONFIG = {
  INITIAL_CAPITAL: 500,           // Capital inicial
  RISK_PER_TRADE: 0.04,           // 4% riesgo por trade
  MAX_OPEN_TRADES: 3,             // Máximo 3 trades abiertos
  
  MIN_VOLUME: 500000,             // Volumen mínimo $500K
  PRICE_MIN: 0.35,                // Precio mínimo
  PRICE_MAX: 0.85,                // Precio máximo
  
  MIN_WHALES: 4,                  // Ballenas necesarias
  TOP_TRADERS: 20,                // Top traders a analizar
  
  STOP_LOSS: 0.12,                // Stop loss 12%
  TAKE_PROFIT_PARTIAL: 0.20,      // Take profit parcial 20%
  TRAILING_STOP: 0.05,            // Trailing stop 5%
  
  MIN_SCORE: 7,                   // Puntuación mínima para trade
  CICLO_SEGUNDOS: 3600            // Cada 1 hora (3600 segundos)
};

// ================= STATE =================
let capital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let priceHistory = {};
let tradesCerrados = [];
let lastTradeTime = 0;
let lossStreak = 0;

// ================= DATOS REALES DE POLYMARKET =================
async function getRealMarkets() {
  try {
    const response = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { limit: 50, closed: false, order: 'volume24hr' }
    });
    return response.data.map(m => ({
      id: m.id,
      price: parseFloat(m.price) || 0.5,
      volume24h: parseFloat(m.volume24hr) || 0,
      question: m.question || m.title || "Mercado",
      liquidity: parseFloat(m.liquidity) || 0
    }));
  } catch (error) {
    console.log("❌ Error obteniendo mercados reales:", error.message);
    return [];
  }
}

async function getRealTraders() {
  try {
    // API de posiciones de traders (simplificada)
    const response = await axios.get('https://gamma-api.polymarket.com/positions');
    const traders = [];
    response.data.forEach(pos => {
      const trader = traders.find(t => t.id === pos.user);
      if (trader) {
        trader.positions.push(pos.marketId);
      } else {
        traders.push({ id: pos.user, positions: [pos.marketId] });
      }
    });
    return traders;
  } catch (error) {
    console.log("⚠️ No se pudieron obtener traders reales, usando simulación");
    // Datos simulados como fallback
    return Array.from({ length: CONFIG.TOP_TRADERS }).map((_, i) => ({
      id: i,
      positions: [1, 2, 3]
    }));
  }
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
  return start === 0 ? 0 : (end - start) / start;
}

function getMomentum(marketId) {
  const history = priceHistory[marketId];
  if (!history || history.length < 3) return 0;
  const prev = history[history.length - 3];
  const current = history[history.length - 1];
  return prev === 0 ? 0 : (current - prev) / prev;
}

function hasConsensus(traders, marketId) {
  const top = traders.slice(0, CONFIG.TOP_TRADERS);
  let count = 0;
  for (const trader of top) {
    if (trader.positions && trader.positions.includes(marketId)) {
      count++;
    }
  }
  return count;
}

// ================= SCORE =================
function calculateScore(market, traders) {
  let score = 0;
  
  if (market.volume24h >= CONFIG.MIN_VOLUME) score += 2;
  if (market.price >= CONFIG.PRICE_MIN && market.price <= CONFIG.PRICE_MAX) score += 1;
  
  const whales = hasConsensus(traders, market.id);
  if (whales >= CONFIG.MIN_WHALES) score += 2;
  
  const trend = getTrend(market.id);
  if (trend > 0.02) score += 2;
  if (trend < -0.02) score += 1;
  
  const momentum = getMomentum(market.id);
  if (momentum > 0.01) score += 2;
  if (momentum < -0.01) score += 1;
  
  return score;
}

// ================= TRADING =================
function getPositionSize() {
  return capital * CONFIG.RISK_PER_TRADE;
}

function openTrade(market) {
  const size = getPositionSize();
  if (capital < size) return false;
  
  capital -= size;
  openTrades.push({
    marketId: market.id,
    marketName: market.question,
    entry: market.price,
    size: size,
    partialClosed: false,
    trailingActive: false,
    peak: market.price,
    openTime: new Date().toISOString()
  });
  
  console.log(`🟢 APERTURA: ${market.question.substring(0, 40)} | $${size.toFixed(2)}`);
  return true;
}

function closeTrade(trade, price, razon) {
  const value = trade.size * (price / trade.entry);
  const pnl = value - trade.size;
  capital += value;
  
  if (pnl < 0) lossStreak++;
  else lossStreak = 0;
  
  tradesCerrados.push({
    ...trade,
    exitPrice: price,
    pnl: pnl,
    razon: razon,
    closeTime: new Date().toISOString()
  });
  
  console.log(`🔴 CIERRE (${razon}): PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Capital: $${capital.toFixed(2)}`);
  openTrades = openTrades.filter(t => t !== trade);
}

function closePartial(trade, price) {
  const half = trade.size * 0.5;
  const value = half * (price / trade.entry);
  const pnl = value - half;
  capital += value;
  trade.size -= half;
  console.log(`🟡 CIERRE PARCIAL 50%: Ganancia +$${pnl.toFixed(2)}`);
}

function manageTrade(trade, currentPrice) {
  const pnl = (currentPrice - trade.entry) / trade.entry;
  
  if (pnl <= -CONFIG.STOP_LOSS) {
    closeTrade(trade, currentPrice, "STOP_LOSS");
    return;
  }
  
  if (pnl >= CONFIG.TAKE_PROFIT_PARTIAL && !trade.partialClosed) {
    closePartial(trade, currentPrice);
    trade.partialClosed = true;
    trade.trailingActive = true;
    trade.peak = currentPrice;
  }
  
  if (trade.trailingActive) {
    if (currentPrice > trade.peak) trade.peak = currentPrice;
    const drop = (trade.peak - currentPrice) / trade.peak;
    if (drop >= CONFIG.TRAILING_STOP) {
      closeTrade(trade, currentPrice, "TRAILING_STOP");
    }
  }
}

// ================= GUARDAR RESULTADOS =================
function guardarResultados() {
  const ganados = tradesCerrados.filter(t => t.pnl > 0).length;
  const perdidos = tradesCerrados.filter(t => t.pnl <= 0).length;
  const pnlTotal = tradesCerrados.reduce((sum, t) => sum + t.pnl, 0);
  const roi = (pnlTotal / CONFIG.INITIAL_CAPITAL) * 100;
  
  let csv = "Fecha,Apertura,Cierre,Market,Entrada,Salida,Tamaño,PnL,Razón\n";
  
  for (const t of tradesCerrados) {
    csv += `${t.openTime},${t.closeTime},"${t.marketName.substring(0, 50)}",${t.entry.toFixed(3)},${t.exitPrice.toFixed(3)},${t.size.toFixed(2)},${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)},${t.razon}\n`;
  }
  
  csv += `\n--- RESUMEN FINAL ---\n`;
  csv += `Capital Inicial,${CONFIG.INITIAL_CAPITAL}\n`;
  csv += `Capital Final,${capital.toFixed(2)}\n`;
  csv += `PnL Total,${pnlTotal.toFixed(2)}\n`;
  csv += `ROI,${roi.toFixed(1)}%\n`;
  csv += `Trades Totales,${tradesCerrados.length}\n`;
  csv += `Ganados,${ganados}\n`;
  csv += `Perdidos,${perdidos}\n`;
  csv += `Win Rate,${tradesCerrados.length > 0 ? (ganados/tradesCerrados.length*100).toFixed(1) : 0}%\n`;
  
  fs.writeFileSync('resultados.csv', csv);
  console.log(`📁 Resultados guardados en resultados.csv`);
}

// ================= MAIN =================
async function runBot() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🔄 CICLO - ${new Date().toLocaleString()}`);
  console.log(`💰 Capital: $${capital.toFixed(2)}`);
  
  const markets = await getRealMarkets();
  if (markets.length === 0) {
    console.log("⚠️ No hay mercados disponibles");
    return;
  }
  
  const traders = await getRealTraders();
  const now = Date.now();
  const cooldownMs = CONFIG.CICLO_SEGUNDOS * 1000;
  
  for (const market of markets) {
    updatePriceHistory(market);
    const score = calculateScore(market, traders);
    
    if (
      score >= CONFIG.MIN_SCORE &&
      openTrades.length < CONFIG.MAX_OPEN_TRADES &&
      !openTrades.find(t => t.marketId === market.id) &&
      now - lastTradeTime > cooldownMs &&
      lossStreak < 2
    ) {
      console.log(`✅ SEÑAL: ${market.question.substring(0, 45)} | Score: ${score}`);
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
  
  const pnlTotal = tradesCerrados.reduce((sum, t) => sum + t.pnl, 0);
  console.log(`📊 PnL Total: ${pnlTotal >= 0 ? '+' : ''}$${pnlTotal.toFixed(2)} | ROI: ${((pnlTotal/CONFIG.INITIAL_CAPITAL)*100).toFixed(1)}%`);
  
  guardarResultados();
}

// ================= INICIAR =================
console.log(`\n🚀 BOT PRO - ESTRATEGIA DE BALLENAS 🚀`);
console.log(`💰 Capital inicial: $${CONFIG.INITIAL_CAPITAL}`);
console.log(`🎲 Riesgo por trade: ${CONFIG.RISK_PER_TRADE * 100}%`);
console.log(`🐋 Ballenas mínimas: ${CONFIG.MIN_WHALES}`);
console.log(`🛡️ Stop Loss: ${CONFIG.STOP_LOSS * 100}%`);
console.log(`📊 Ciclo: cada ${CONFIG.CICLO_SEGUNDOS / 60} minutos\n`);

runBot();
setInterval(runBot, CONFIG.CICLO_SEGUNDOS * 1000);
