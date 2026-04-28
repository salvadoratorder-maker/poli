import fetch from "node-fetch";

// ═══════════════════════════════════════════════════════════════
//  POLYPAPER BOT — con detector de consenso whales (Opción C)
//
//  Detecta dinero inteligente mediante 3 señales indirectas:
//  1. Spike de volumen — alguien grande está comprando
//  2. Movimiento de precio — hay presión direccional real
//  3. Absorción de liquidez — están comiendo el order book
//
//  No necesita API de traders — usa datos públicos de Polymarket
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Capital y riesgo
  INITIAL_CAPITAL:       200,
  RISK_PER_TRADE:        0.03,   // 3% del capital por trade
  MAX_OPEN_TRADES:       3,

  // Filtros básicos de mercado
  MIN_VOLUME_24H:        500000, // mínimo $500K volumen 24h
  PRICE_MIN:             0.25,
  PRICE_MAX:             0.75,
  MIN_LIQUIDITY:         50000,  // mínimo $50K liquidez

  // ── DETECTOR DE WHALES (Opción C) ──────────────────────────
  // Señal 1 — Spike de volumen
  // Si el volumen de hoy es X veces mayor que la media → whale entrando
  VOLUME_SPIKE_MULTIPLIER: 2.0,  // volumen hoy > 2x la media semanal

  // Señal 2 — Momentum de precio
  // Si el precio ha subido X% desde que empezamos a monitorizar → presión compradora
  PRICE_MOMENTUM_MIN:    0.03,   // +3% de movimiento mínimo

  // Señal 3 — Absorción de liquidez
  // Si la liquidez bajó mientras el volumen subió → están comprando el order book
  LIQUIDITY_DROP_MIN:    0.05,   // liquidez bajó >5%

  // Consenso mínimo — cuántas de las 3 señales tienen que coincidir
  MIN_WHALE_SIGNALS:     2,      // al menos 2 de 3 señales activas

  // Gestión de posición
  STOP_LOSS:             0.12,   // 12%
  TAKE_PROFIT_PARTIAL:   0.20,   // cierre 50% en +20%
  TRAILING_STOP:         0.065,  // trailing 6.5%

  // Ciclo
  INTERVAL_MS:           60 * 60 * 1000, // cada hora
};

// ═══════════════════════════════════════════════════════════════
//  ESTADO
// ═══════════════════════════════════════════════════════════════

let capital      = CONFIG.INITIAL_CAPITAL;
let openTrades   = [];
let closedTrades = [];
let cycleCount   = 0;

// Memoria de mercados — guardamos snapshots para detectar cambios
// { slug: { price, volume, liquidity, timestamp } }
let marketMemory = {};

// ═══════════════════════════════════════════════════════════════
//  UTILIDADES
// ═══════════════════════════════════════════════════════════════

function now() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

function stats() {
  const wins  = closedTrades.filter(t => t.pnl > 0).length;
  const total = closedTrades.length;
  const pnl   = capital - CONFIG.INITIAL_CAPITAL;
  const roi   = ((pnl / CONFIG.INITIAL_CAPITAL) * 100).toFixed(1);
  const wr    = total > 0 ? ((wins / total) * 100).toFixed(0) : "—";
  log(`💰 CAPITAL: ${capital.toFixed(2)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ROI: ${roi}% | WR: ${wr}% (${wins}/${total})`);
  log(`   Abiertos: ${openTrades.length} | Cerrados: ${total}`);
}

// ═══════════════════════════════════════════════════════════════
//  API POLYMARKET
// ═══════════════════════════════════════════════════════════════

async function getMarkets() {
  try {
    const url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30";
    const res  = await fetch(url);
    if (!res.ok) throw new Error("Status " + res.status);
    const data = await res.json();

    return data
      .filter(m => m && m.id)
      .map(m => {
        let price = 0;
        try {
          const prices = JSON.parse(m.outcomePrices || "[]");
          price = parseFloat(prices[0]) || 0;
        } catch {
          price = parseFloat(m.lastPrice) || 0;
        }

        // Volumen total (no solo 24h) para calcular media
        const volumeTotal = parseFloat(m.volume)    || 0;
        const volume24h   = parseFloat(m.volume24hr) || 0;

        // Media diaria estimada desde el inicio del mercado
        let volumeAvgDaily = volume24h;
        if (m.startDate && volumeTotal > 0) {
          const daysActive = Math.max(1,
            (Date.now() - new Date(m.startDate)) / (1000 * 60 * 60 * 24)
          );
          volumeAvgDaily = volumeTotal / daysActive;
        }

        return {
          id:             m.id,
          slug:           m.slug || m.id,
          question:       (m.question || m.id).substring(0, 70),
          price,
          volume24h,
          volumeAvgDaily,
          liquidity:      parseFloat(m.liquidity) || 0,
          endDate:        m.endDate || "",
          startDate:      m.startDate || "",
        };
      });

  } catch (err) {
    log("❌ Error API Polymarket: " + err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  DETECTOR DE WHALES — OPCIÓN C
//  Analiza 3 señales indirectas de dinero inteligente
// ═══════════════════════════════════════════════════════════════

function detectWhaleActivity(market) {
  const signals     = [];
  const slug        = market.slug;
  const prev        = marketMemory[slug]; // snapshot del ciclo anterior
  const now_ts      = Date.now();

  // ── SEÑAL 1 — SPIKE DE VOLUMEN ─────────────────────────────
  // Si el volumen de hoy es 2x mayor que la media diaria histórica
  // → alguien grande está apostando hoy específicamente
  const volRatio = market.volumeAvgDaily > 0
    ? market.volume24h / market.volumeAvgDaily
    : 1;

  const signal1 = volRatio >= CONFIG.VOLUME_SPIKE_MULTIPLIER;
  if (signal1) {
    signals.push({
      type:  "VOLUMEN",
      detail: `Vol hoy $${(market.volume24h/1e6).toFixed(2)}M vs media $${(market.volumeAvgDaily/1e6).toFixed(2)}M/día (x${volRatio.toFixed(1)})`,
      strength: Math.min(1, volRatio / 5), // normalizado 0-1
    });
  }

  // ── SEÑAL 2 — MOMENTUM DE PRECIO ───────────────────────────
  // Si el precio se ha movido >3% desde el último ciclo
  // → hay presión compradora sostenida (no ruido)
  if (prev) {
    const priceDelta = (market.price - prev.price) / prev.price;
    const signal2    = Math.abs(priceDelta) >= CONFIG.PRICE_MOMENTUM_MIN;

    if (signal2) {
      const direction = priceDelta > 0 ? "⬆ subiendo" : "⬇ bajando";
      signals.push({
        type:  "MOMENTUM",
        detail: `Precio ${direction} ${(priceDelta * 100).toFixed(1)}% desde último ciclo ($${prev.price.toFixed(3)} → $${market.price.toFixed(3)})`,
        strength: Math.min(1, Math.abs(priceDelta) / 0.15),
        direction: priceDelta > 0 ? "UP" : "DOWN",
      });
    }
  }

  // ── SEÑAL 3 — ABSORCIÓN DE LIQUIDEZ ────────────────────────
  // Si el volumen subió pero la liquidez bajó
  // → los whales están comprando las órdenes disponibles
  // → el order book se está vaciando de un lado
  if (prev) {
    const liqDelta = prev.liquidity > 0
      ? (prev.liquidity - market.liquidity) / prev.liquidity
      : 0;

    const volUp  = market.volume24h > prev.volume24h * 1.1;
    const liqDn  = liqDelta >= CONFIG.LIQUIDITY_DROP_MIN;
    const signal3 = volUp && liqDn;

    if (signal3) {
      signals.push({
        type:  "ABSORCIÓN",
        detail: `Liquidez bajó ${(liqDelta * 100).toFixed(1)}% mientras volumen subió → order book siendo absorbido`,
        strength: Math.min(1, liqDelta / 0.20),
      });
    }
  }

  // ── RESULTADO FINAL ─────────────────────────────────────────
  const activeSignals = signals.length;
  const passed        = activeSignals >= CONFIG.MIN_WHALE_SIGNALS;

  // Score de consenso 0-100
  const score = activeSignals > 0
    ? Math.round((signals.reduce((a, s) => a + s.strength, 0) / signals.length) * 100)
    : 0;

  return {
    passed,
    signals,
    activeSignals,
    score,
    // Dirección dominante del momentum (si existe)
    direction: signals.find(s => s.direction)?.direction || "UP",
  };
}

// ═══════════════════════════════════════════════════════════════
//  FILTROS DE ENTRADA
// ═══════════════════════════════════════════════════════════════

function isValidMarket(market) {
  if (market.volume24h < CONFIG.MIN_VOLUME_24H)  return false;
  if (market.price < CONFIG.PRICE_MIN)           return false;
  if (market.price > CONFIG.PRICE_MAX)           return false;
  if (market.liquidity < CONFIG.MIN_LIQUIDITY)   return false;
  if (openTrades.find(t => t.slug === market.slug)) return false;

  if (market.endDate) {
    const daysLeft = (new Date(market.endDate) - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 1) return false;
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════
//  ABRIR TRADE
// ═══════════════════════════════════════════════════════════════

function openTrade(market, whaleData) {
  const size = parseFloat((capital * CONFIG.RISK_PER_TRADE).toFixed(2));

  if (capital < size) {
    log(`⚠ Capital insuficiente: $${capital.toFixed(2)}`);
    return;
  }

  capital -= size;

  openTrades.push({
    slug:           market.slug,
    question:       market.question,
    entry:          market.price,
    size,
    partialClosed:  false,
    trailingActive: false,
    peak:           market.price,
    openDate:       now(),
    stopPrice:      parseFloat((market.price * (1 - CONFIG.STOP_LOSS)).toFixed(4)),
    targetPrice:    parseFloat((market.price * (1 + CONFIG.TAKE_PROFIT_PARTIAL)).toFixed(4)),
    whaleScore:     whaleData.score,
    whaleSignals:   whaleData.activeSignals,
  });

  log(`🟢 OPEN: ${market.question}`);
  log(`   Precio: $${market.price.toFixed(3)} | Size: $${size.toFixed(2)} | Stop: $${(market.price*(1-CONFIG.STOP_LOSS)).toFixed(3)} | Target: $${(market.price*(1+CONFIG.TAKE_PROFIT_PARTIAL)).toFixed(3)}`);
  log(`   🐋 Whale score: ${whaleData.score}/100 | Señales: ${whaleData.activeSignals}/3`);
  whaleData.signals.forEach(s => log(`      ✓ ${s.type}: ${s.detail}`));
}

// ═══════════════════════════════════════════════════════════════
//  GESTIONAR TRADE ABIERTO
// ═══════════════════════════════════════════════════════════════

function closeTrade(trade, price, reason) {
  const value = trade.size * (price / trade.entry);
  const pnl   = value - trade.size;
  capital    += value;

  closedTrades.push({ ...trade, exitPrice: price, exitDate: now(), pnl, result: pnl >= 0 ? "WIN" : "LOSS", reason });
  openTrades = openTrades.filter(t => t !== trade);

  const icon = pnl >= 0 ? "💰" : "🛑";
  log(`${icon} CLOSE (${reason}): ${trade.question}`);
  log(`   $${trade.entry.toFixed(3)} → $${price.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
}

function closePartial(trade, price) {
  const half = trade.size * 0.5;
  const pnl  = half * (price / trade.entry) - half;
  capital   += half + pnl;
  trade.size -= half;
  log(`✂️  PARTIAL: ${trade.question} @ $${price.toFixed(3)} | +$${pnl.toFixed(2)}`);
}

function manageTrade(trade, currentPrice) {
  const pnlPct = (currentPrice - trade.entry) / trade.entry;

  if (currentPrice <= trade.stopPrice) {
    closeTrade(trade, currentPrice, "STOP_LOSS"); return;
  }

  if (pnlPct >= CONFIG.TAKE_PROFIT_PARTIAL && !trade.partialClosed) {
    closePartial(trade, currentPrice);
    trade.partialClosed  = true;
    trade.trailingActive = true;
    trade.peak           = currentPrice;
    return;
  }

  if (trade.trailingActive) {
    if (currentPrice > trade.peak) {
      trade.peak = currentPrice;
    }
    const drop = (trade.peak - currentPrice) / trade.peak;
    if (drop >= CONFIG.TRAILING_STOP) {
      closeTrade(trade, currentPrice, "TRAILING_STOP");
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  CICLO PRINCIPAL
// ═══════════════════════════════════════════════════════════════

async function runBot() {
  cycleCount++;
  log(`════ CICLO #${cycleCount} ══════════════════════════════`);

  // 1. Cargar mercados
  const markets = await getMarkets();
  if (!markets.length) {
    log("⚠ Sin mercados"); return;
  }
  log(`✓ ${markets.length} mercados cargados`);

  // 2. Actualizar trades abiertos
  if (openTrades.length > 0) {
    log(`↻ Actualizando ${openTrades.length} trade(s)...`);
    for (const trade of [...openTrades]) {
      const m = markets.find(m => m.slug === trade.slug);
      if (m && m.price > 0) manageTrade(trade, m.price);
    }
  }

  // 3. Buscar señales con detector de whales
  if (openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    log(`🔍 Analizando señales de whales...`);
    log(`   (necesito ${CONFIG.MIN_WHALE_SIGNALS}/3 señales para entrar)\n`);

    let found = 0;

    for (const market of markets) {
      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
      if (!isValidMarket(market)) continue;

      // ── DETECTOR DE WHALES ──
      const whaleData = detectWhaleActivity(market);

      // Log del análisis de cada mercado
      const icon = whaleData.passed ? "✅" : "❌";
      log(`${icon} ${market.question.substring(0, 50)}`);
      log(`   Precio: $${market.price.toFixed(3)} | Vol: $${(market.volume24h/1e6).toFixed(1)}M | Señales whale: ${whaleData.activeSignals}/3 | Score: ${whaleData.score}/100`);

      if (!whaleData.passed) {
        log(`   → Sin consenso suficiente (${whaleData.activeSignals} < ${CONFIG.MIN_WHALE_SIGNALS})`);
        continue;
      }

      log(`   → 🐋 CONSENSO DETECTADO — entrando`);
      openTrade(market, whaleData);
      found++;
    }

    if (found === 0) log("\nℹ Sin señales de whale en este ciclo");
  }

  // 4. Actualizar memoria de mercados para el próximo ciclo
  markets.forEach(m => {
    marketMemory[m.slug] = {
      price:     m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
      timestamp: Date.now(),
    };
  });

  // 5. Estadísticas
  log("\n────────────────────────────────────────────────");
  stats();
  log(`════ FIN CICLO #${cycleCount} (próximo en 1h) ══════\n`);
}

// ═══════════════════════════════════════════════════════════════
//  ARRANCAR
// ═══════════════════════════════════════════════════════════════

log("🚀 PolyPaper Bot — Detector de Whales (Opción C)");
log(`   Capital virtual: $${CONFIG.INITIAL_CAPITAL}`);
log(`   Señales whale necesarias: ${CONFIG.MIN_WHALE_SIGNALS}/3`);
log(`   Vol spike: x${CONFIG.VOLUME_SPIKE_MULTIPLIER} | Momentum: +${CONFIG.PRICE_MOMENTUM_MIN*100}% | Absorción: -${CONFIG.LIQUIDITY_DROP_MIN*100}% liquidez`);
log(`   Stop: ${CONFIG.STOP_LOSS*100}% | Trailing: ${CONFIG.TRAILING_STOP*100}%\n`);

// Primera ejecución al arrancar, luego cada hora
runBot();
setInterval(runBot, CONFIG.INTERVAL_MS);
