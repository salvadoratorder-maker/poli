import fetch from "node-fetch";

// ═══════════════════════════════════════
//  POLYPAPER BOT — versión corregida
//  - Ciclo cada 1 hora (no cada 10s)
//  - Lee precios correctamente de la API
//  - No repite mercados ya abiertos
//  - Guarda log claro de todo
// ═══════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL:      200,    // capital virtual en dólares
  RISK_PER_TRADE:       0.03,   // 3% del capital por trade
  MAX_OPEN_TRADES:      3,      // máximo 3 trades a la vez
  MIN_VOLUME:           500000, // mínimo $500K volumen 24h
  PRICE_MIN:            0.25,   // precio mínimo de entrada
  PRICE_MAX:            0.75,   // precio máximo de entrada
  STOP_LOSS:            0.12,   // stop loss 12%
  TAKE_PROFIT_PARTIAL:  0.20,   // cierre parcial 50% en +20%
  TRAILING_STOP:        0.065,  // trailing stop 6.5%
  INTERVAL_MS:          60 * 60 * 1000, // 1 hora entre ciclos
};

// ═══════════════════════════════════════
//  ESTADO DEL BOT
// ═══════════════════════════════════════

let capital    = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let cycleCount = 0;

// ═══════════════════════════════════════
//  UTILIDADES
// ═══════════════════════════════════════

function now() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

function stats() {
  const wins   = closedTrades.filter(t => t.pnl > 0).length;
  const total  = closedTrades.length;
  const pnl    = capital - CONFIG.INITIAL_CAPITAL;
  const roi    = ((pnl / CONFIG.INITIAL_CAPITAL) * 100).toFixed(1);
  const wr     = total > 0 ? ((wins / total) * 100).toFixed(0) : "—";

  log(`💰 CAPITAL: ${capital.toFixed(2)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ROI: ${roi}% | WR: ${wr}% (${wins}/${total})`);
  log(`   Abiertos: ${openTrades.length} | Cerrados: ${total}`);
}

// ═══════════════════════════════════════
//  API POLYMARKET — lee precios reales
// ═══════════════════════════════════════

async function getMarkets() {
  try {
    const url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30";
    const res  = await fetch(url);

    if (!res.ok) throw new Error("Status " + res.status);

    const data = await res.json();

    return data
      .filter(m => m && m.id)
      .map(m => {
        // Lee el precio correctamente — Polymarket lo guarda en outcomePrices
        let price = 0;
        try {
          const prices = JSON.parse(m.outcomePrices || "[]");
          price = parseFloat(prices[0]) || 0;
        } catch {
          price = parseFloat(m.lastPrice) || 0;
        }

        return {
          id:        m.id,
          slug:      m.slug || m.id,
          question:  m.question || m.id,
          price,
          volume24h: parseFloat(m.volume24hr) || 0,
          liquidity: parseFloat(m.liquidity)  || 0,
          endDate:   m.endDate || "",
        };
      });

  } catch (err) {
    log("❌ Error API Polymarket: " + err.message);
    return [];
  }
}

// ═══════════════════════════════════════
//  FILTROS DE ENTRADA
//  Un mercado tiene que pasar todos para entrar
// ═══════════════════════════════════════

function isValidMarket(market) {
  // ① Volumen suficiente
  if (market.volume24h < CONFIG.MIN_VOLUME) return false;

  // ② Precio en rango — no demasiado cerca de 0 o 1
  if (market.price < CONFIG.PRICE_MIN) return false;
  if (market.price > CONFIG.PRICE_MAX) return false;

  // ③ No está ya abierto
  if (openTrades.find(t => t.slug === market.slug)) return false;

  // ④ Tiene liquidez mínima
  if (market.liquidity < 50000) return false;

  // ⑤ No resuelve hoy (necesitamos tiempo para que se mueva)
  if (market.endDate) {
    const daysLeft = (new Date(market.endDate) - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 1) return false;
  }

  return true;
}

// ═══════════════════════════════════════
//  ABRIR TRADE
// ═══════════════════════════════════════

function openTrade(market) {
  const size = parseFloat((capital * CONFIG.RISK_PER_TRADE).toFixed(2));

  if (capital < size) {
    log(`⚠ Capital insuficiente: $${capital.toFixed(2)}`);
    return;
  }

  capital -= size;

  const trade = {
    slug:          market.slug,
    question:      market.question.substring(0, 60),
    entry:         market.price,
    size,
    partialClosed: false,
    trailingActive: false,
    peak:          market.price,
    openDate:      now(),
    stopPrice:     parseFloat((market.price * (1 - CONFIG.STOP_LOSS)).toFixed(4)),
    targetPrice:   parseFloat((market.price * (1 + CONFIG.TAKE_PROFIT_PARTIAL)).toFixed(4)),
  };

  openTrades.push(trade);

  log(`🟢 OPEN: ${trade.question}`);
  log(`   Entrada: $${trade.entry.toFixed(3)} | Size: $${size.toFixed(2)} | Stop: $${trade.stopPrice} | Target: $${trade.targetPrice}`);
  log(`   Vol 24h: $${(market.volume24h / 1e6).toFixed(1)}M`);
}

// ═══════════════════════════════════════
//  CERRAR TRADE COMPLETO
// ═══════════════════════════════════════

function closeTrade(trade, price, reason) {
  const value = trade.size * (price / trade.entry);
  const pnl   = value - trade.size;

  capital += value;

  closedTrades.push({
    ...trade,
    exitPrice:  price,
    exitDate:   now(),
    pnl,
    result:     pnl >= 0 ? "WIN" : "LOSS",
    reason,
  });

  openTrades = openTrades.filter(t => t !== trade);

  const icon = pnl >= 0 ? "💰" : "🛑";
  log(`${icon} CLOSE (${reason}): ${trade.question}`);
  log(`   Entrada: $${trade.entry.toFixed(3)} → Salida: $${price.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
}

// ═══════════════════════════════════════
//  CERRAR PARCIAL (50%)
// ═══════════════════════════════════════

function closePartial(trade, price) {
  const half  = trade.size * 0.5;
  const value = half * (price / trade.entry);
  const pnl   = value - half;

  capital    += value;
  trade.size -= half;

  log(`✂️  PARTIAL (50%): ${trade.question}`);
  log(`   Precio: $${price.toFixed(3)} | PnL parcial: +$${pnl.toFixed(2)} | Resto: $${trade.size.toFixed(2)}`);
}

// ═══════════════════════════════════════
//  GESTIONAR TRADE ABIERTO
// ═══════════════════════════════════════

function manageTrade(trade, currentPrice) {
  const pnlPct = (currentPrice - trade.entry) / trade.entry;

  // ① STOP LOSS — salir si cae demasiado
  if (currentPrice <= trade.stopPrice) {
    closeTrade(trade, currentPrice, "STOP_LOSS");
    return;
  }

  // ② CIERRE PARCIAL — si sube +20%, cierra el 50%
  if (pnlPct >= CONFIG.TAKE_PROFIT_PARTIAL && !trade.partialClosed) {
    closePartial(trade, currentPrice);
    trade.partialClosed  = true;
    trade.trailingActive = true;
    trade.peak           = currentPrice;
    log(`   Trailing activado desde $${currentPrice.toFixed(3)}`);
    return;
  }

  // ③ TRAILING STOP — una vez activado, sigue el precio
  if (trade.trailingActive) {
    // actualiza el pico máximo
    if (currentPrice > trade.peak) {
      trade.peak = currentPrice;
      log(`   📈 Nuevo máximo: $${trade.peak.toFixed(3)} (trail stop: $${(trade.peak * (1 - CONFIG.TRAILING_STOP)).toFixed(3)})`);
    }

    // cierra si cae X% desde el pico
    const dropFromPeak = (trade.peak - currentPrice) / trade.peak;
    if (dropFromPeak >= CONFIG.TRAILING_STOP) {
      closeTrade(trade, currentPrice, "TRAILING_STOP");
      return;
    }
  }
}

// ═══════════════════════════════════════
//  CICLO PRINCIPAL — se ejecuta cada hora
// ═══════════════════════════════════════

async function runBot() {
  cycleCount++;
  log(`════ CICLO #${cycleCount} ══════════════════════════════`);

  // 1. Cargar mercados reales de Polymarket
  const markets = await getMarkets();
  if (!markets.length) {
    log("⚠ Sin mercados — reintentando en próximo ciclo");
    return;
  }
  log(`✓ ${markets.length} mercados cargados`);

  // 2. Actualizar trades abiertos con precios nuevos
  if (openTrades.length > 0) {
    log(`↻ Actualizando ${openTrades.length} trade(s) abierto(s)...`);
    for (const trade of [...openTrades]) {
      const market = markets.find(m => m.slug === trade.slug);
      if (market && market.price > 0) {
        manageTrade(trade, market.price);
      }
    }
  }

  // 3. Buscar nuevas señales si hay hueco
  if (openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    log(`🔍 Buscando señales (${openTrades.length}/${CONFIG.MAX_OPEN_TRADES} trades abiertos)...`);

    let opened = 0;
    for (const market of markets) {
      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
      if (!isValidMarket(market)) continue;

      log(`📡 Señal: ${market.question.substring(0, 55)}`);
      log(`   Precio: $${market.price.toFixed(3)} | Vol: $${(market.volume24h / 1e6).toFixed(1)}M`);
      openTrade(market);
      opened++;
    }

    if (opened === 0) log("ℹ Sin señales nuevas en este ciclo");
  } else {
    log(`ℹ Máximo de trades abiertos alcanzado (${CONFIG.MAX_OPEN_TRADES})`);
  }

  // 4. Estadísticas finales del ciclo
  log("────────────────────────────────────────────────");
  stats();
  log(`════ FIN CICLO #${cycleCount} ══════════════════════════\n`);
}

// ═══════════════════════════════════════
//  ARRANCAR
// ═══════════════════════════════════════

log("🚀 PolyPaper Bot arrancado");
log(`   Capital virtual: $${CONFIG.INITIAL_CAPITAL}`);
log(`   Riesgo por trade: ${CONFIG.RISK_PER_TRADE * 100}% ($${(CONFIG.INITIAL_CAPITAL * CONFIG.RISK_PER_TRADE).toFixed(2)} por operación)`);
log(`   Máx trades simultáneos: ${CONFIG.MAX_OPEN_TRADES}`);
log(`   Stop loss: ${CONFIG.STOP_LOSS * 100}% | Trailing: ${CONFIG.TRAILING_STOP * 100}%`);
log(`   Ciclo: cada ${CONFIG.INTERVAL_MS / 60000} minutos\n`);

// Ejecuta una vez al arrancar, luego cada hora
runBot();
setInterval(runBot, CONFIG.INTERVAL_MS);
