// ============================================================
// MICRODRIFT v5.0 — Paper Trading / Polymarket
// Estrategia: mean reversion con ventana histórica de precios
//
// AVISO: Paper trading únicamente. Los mercados de predicción
// implican riesgo de pérdida total del capital. No hay garantía
// de rentabilidad. Los resultados pasados no predicen el futuro.
// ============================================================

import fs from "fs";
import fetch from "node-fetch";

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  // Capital inicial por bot (paper money)
  INITIAL_EQUITY: 200,

  // Filtros de mercado
  PRICE_MIN: 0.15,       // más amplio que v4 para más oportunidades
  PRICE_MAX: 0.95,
  MIN_VOLUME_24H: 10_000, // volumen mínimo robusto
  MIN_LIQ: 5_000,        // liquidez mínima más estricta

  // Gestión de riesgo
  RISK_PER_TRADE: 0.025,  // 2.5% del equity por trade
  MAX_OPEN_PER_BOT: 2,

  // PnL: fees realistas (spread + protocolo)
  FEE_RATE: 0.02,         // 2% por operación (conservador)

  // Salidas
  STOP_LOSS_ROI: -0.12,   // −12% sobre el capital invertido
  TAKE_PROFIT_ROI: 0.20,  //  +20% sobre el capital invertido
  MAX_HOLD_MS: 6 * 60 * 60 * 1000, // 6 horas máximo

  // Ciclo
  CYCLE_INTERVAL_MS: 60 * 60 * 1000, // 1 hora

  // Ventana histórica para mean reversion
  HISTORY_WINDOW: 6,       // ciclos para calcular media y desviación
  REVERSION_THRESHOLD: 1.5, // z-score mínimo para señal (precio alejado de media)
  MIN_HIST_CYCLES: 2,      // mínimo de datos antes de operar
};

// ─── BOTS ─────────────────────────────────────────────────────
// Tres perfiles con distintos umbrales de z-score
// A: más selectivo (espera mayor anomalía)
// B: equilibrado
// C: más agresivo (actúa con anomalías menores)
const BOTS = {
  A: { MIN_ZSCORE: 2.0, label: "Conservative" },
  B: { MIN_ZSCORE: 1.8, label: "Balanced"     },
  C: { MIN_ZSCORE: 1.8, label: "Aggressive"   },
};

// ─── ESTADO ───────────────────────────────────────────────────
const STATE_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/state_v5.json`
  : "./state_v5.json";
let state = loadState();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // Compatibilidad: asegurar que history existe
    if (!raw.history) raw.history = {};
    return raw;
  } catch {
    return {
      cycle: 0,
      history: {},        // slug → array de precios (últimos HISTORY_WINDOW)
      positions: [],
      closed: [],
      equity: { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY },
      peak:   { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY },
      dd:     { A: 0, B: 0, C: 0 },
    };
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── LOGGING ──────────────────────────────────────────────────
function log(msg, level = "INFO") {
  const prefix = level === "WARN" ? "⚠ " : level === "ERR" ? "✖ " : level === "TRADE" ? "◆ " : "  ";
  console.log(`[${new Date().toISOString()}] ${prefix}${msg}`);
}

// ─── API ──────────────────────────────────────────────────────
async function fetchMarkets() {
  try {
    const res = await fetch(
      `${CONFIG.API}/markets?active=true&closed=false&limit=150`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Origin": "https://polymarket.com",
          "Referer": "https://polymarket.com/",
        },
        timeout: 20_000
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return data
      .map(m => ({
        slug:      m.slug,
        question:  (m.question || m.slug).slice(0, 60),
        price:     extractBestPrice(m),
        volume24h: Number(m.volume24hr || 0),
        liquidity: Number(m.liquidity || 0),
      }))
      .filter(m => m.price > 0.005 && m.price < 0.995);

  } catch (err) {
    log(`fetchMarkets failed: ${err.message}`, "ERR");
    return [];
  }
}

function extractBestPrice(m) {
  try {
    let prices = [];
    if (Array.isArray(m.outcomePrices)) {
      prices = m.outcomePrices.map(Number).filter(p => p > 0 && p < 1);
    } else if (typeof m.outcomePrices === "string") {
      prices = JSON.parse(m.outcomePrices).map(Number).filter(p => p > 0 && p < 1);
    }
    // Devuelve el precio más cercano a 0.5 (más líquido / menos extremo)
    if (prices.length > 0) {
      return prices.reduce((a, b) =>
        Math.abs(b - 0.5) < Math.abs(a - 0.5) ? b : a, prices[0]
      );
    }
    return Number(m.lastPrice || 0.5);
  } catch {
    return Number(m.lastPrice || 0.5);
  }
}

// ─── FILTROS ──────────────────────────────────────────────────
function filterMarkets(markets) {
  const rejected = { price: 0, volume: 0, liquidity: 0 };
  const valid = [];

  for (const m of markets) {
    if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) {
      rejected.price++;
      continue;
    }
    if (m.volume24h < CONFIG.MIN_VOLUME_24H) {
      rejected.volume++;
      continue;
    }
    if (m.liquidity < CONFIG.MIN_LIQ) {
      rejected.liquidity++;
      continue;
    }
    valid.push(m);
  }

  return { valid, rejected };
}

// ─── HISTORIA DE PRECIOS ──────────────────────────────────────
function updateHistory(markets) {
  for (const m of markets) {
    if (!state.history[m.slug]) state.history[m.slug] = [];
    state.history[m.slug].push(m.price);
    // Mantener solo los últimos N ciclos
    if (state.history[m.slug].length > CONFIG.HISTORY_WINDOW) {
      state.history[m.slug].shift();
    }
  }

  // Limpiar slugs que ya no aparecen (mercados cerrados)
  const activeSlugs = new Set(markets.map(m => m.slug));
  for (const slug of Object.keys(state.history)) {
    if (!activeSlugs.has(slug)) delete state.history[slug];
  }
}

// ─── SEÑAL: MEAN REVERSION ────────────────────────────────────
// Calcula z-score del precio actual respecto a su historia reciente.
// Un z-score negativo alto = precio muy por debajo de su media → posible rebote alcista
// Un z-score positivo alto = precio muy por encima → posible rebote bajista
//
// Solo operamos en dirección de REBOTE (compramos el "dip", no seguimos tendencia).
function computeSignal(m) {
  const hist = state.history[m.slug];
  if (!hist || hist.length < CONFIG.MIN_HIST_CYCLES) {
    return null; // datos insuficientes
  }

  const n = hist.length;
  const mean = hist.reduce((s, p) => s + p, 0) / n;

  // Desviación estándar muestral
  const variance = hist.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);

  if (std < 0.005) return null; // mercado inactivo, sin señal

  const currentPrice = m.price;
  const zScore = (currentPrice - mean) / std;

  // Dirección del trade esperado:
  // precio muy bajo → esperamos rebote → BUY (largo)
  // precio muy alto → esperamos caída → usamos precio inverso (1-p) como proxy
  let direction, entryPrice, expectedReversion;
  if (zScore < -CONFIG.REVERSION_THRESHOLD) {
    direction = "BUY";
    entryPrice = currentPrice;
    expectedReversion = mean;  // objetivo: volver a la media
  } else if (zScore > CONFIG.REVERSION_THRESHOLD) {
    direction = "SELL_PROXY"; // en Polymarket binario: compramos el NO (1-price)
    entryPrice = 1 - currentPrice;
    expectedReversion = 1 - mean;
  } else {
    return null; // no hay señal suficiente
  }

  const absZScore = Math.abs(zScore);

  // Calidad adicional: volumen y liquidez como multiplicadores
  const volBonus  = Math.min(1.2, 1 + (m.volume24h - CONFIG.MIN_VOLUME_24H) / 500_000);
  const liqBonus  = Math.min(1.1, 1 + (m.liquidity - CONFIG.MIN_LIQ) / 200_000);
  const qualScore = absZScore * volBonus * liqBonus;

  return {
    direction,
    entryPrice,
    expectedReversion,
    zScore,
    absZScore,
    qualScore,
    mean,
    std,
    histLen: n,
  };
}

// ─── POSICIONES ───────────────────────────────────────────────

// PnL CORRECTO para mercados de predicción (contratos binarios USDC)
// Shares compradas = invested / entry_price
// PnL bruto = shares * (exit_price - entry_price)
// PnL neto  = PnL bruto - fees sobre el capital invertido
function calcPnl(entryPrice, exitPrice, invested) {
  const shares = invested / entryPrice;
  const grossPnl = shares * (exitPrice - entryPrice);
  const fees = invested * CONFIG.FEE_RATE;
  return grossPnl - fees;
}

function hasDuplicate(bot, slug) {
  return state.positions.some(p => p.bot === bot && p.slug === slug);
}

function openPosition(bot, m, signal) {
  if (hasDuplicate(bot, m.slug)) return;

  const botPositions = state.positions.filter(p => p.bot === bot).length;
  if (botPositions >= CONFIG.MAX_OPEN_PER_BOT) return;

  if (state.equity[bot] < 10) {
    log(`${bot}: equity insuficiente (${state.equity[bot].toFixed(2)})`, "WARN");
    return;
  }

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;
  state.equity[bot] -= invested;

  const pos = {
    bot,
    slug: m.slug,
    question: m.question,
    direction: signal.direction,
    entry: signal.entryPrice,
    expectedExit: signal.expectedReversion,
    zScoreAtEntry: signal.zScore,
    invested,
    shares: invested / signal.entryPrice,
    opened: Date.now(),
    cycleOpened: state.cycle,
  };

  state.positions.push(pos);

  log(
    `OPEN ${bot} [${signal.direction}] ${m.slug.slice(0, 30)} ` +
    `entry=${signal.entryPrice.toFixed(3)} z=${signal.zScore.toFixed(2)} ` +
    `invested=$${invested.toFixed(2)}`,
    "TRADE"
  );
}

function closePosition(pos, exitPrice, reason) {
  const netPnl = calcPnl(pos.entry, exitPrice, pos.invested);
  state.equity[pos.bot] += pos.invested + netPnl;

  // Actualizar peak y drawdown
  const eq = state.equity[pos.bot];
  state.peak[pos.bot] = Math.max(state.peak[pos.bot], eq);
  const dd = (state.peak[pos.bot] - eq) / state.peak[pos.bot];
  state.dd[pos.bot] = Math.max(state.dd[pos.bot], dd);

  const roi = netPnl / pos.invested;

  state.closed.push({
    ...pos,
    exit: exitPrice,
    pnl: netPnl,
    roi,
    reason,
    closeTime: Date.now(),
    holdMs: Date.now() - pos.opened,
  });

  state.positions = state.positions.filter(p => p !== pos);

  const emoji = netPnl > 0 ? "+" : "";
  log(
    `CLOSE ${pos.bot} [${reason}] ${pos.slug.slice(0, 25)} ` +
    `pnl=${emoji}$${netPnl.toFixed(2)} roi=${(roi * 100).toFixed(1)}%`,
    "TRADE"
  );
}

// ─── GESTIÓN DE POSICIONES ABIERTAS ───────────────────────────
function managePositions(markets) {
  const now = Date.now();
  const priceMap = new Map(markets.map(m => [m.slug, m.price]));

  for (const pos of [...state.positions]) {
    const rawPrice = priceMap.get(pos.slug);
    if (rawPrice === undefined) continue;

    // Precio efectivo según dirección del trade
    const effectivePrice = pos.direction === "SELL_PROXY"
      ? 1 - rawPrice
      : rawPrice;

    const roi = (effectivePrice - pos.entry) / pos.entry;

    // Stop loss
    if (roi <= CONFIG.STOP_LOSS_ROI) {
      closePosition(pos, effectivePrice, "STOP_LOSS");
      continue;
    }

    // Take profit
    if (roi >= CONFIG.TAKE_PROFIT_ROI) {
      closePosition(pos, effectivePrice, "TAKE_PROFIT");
      continue;
    }

    // Tiempo máximo
    if (now - pos.opened > CONFIG.MAX_HOLD_MS) {
      closePosition(pos, effectivePrice, "TIMEOUT");
      continue;
    }

    // Salida anticipada si el precio revirtió más del 60% del camino a la media
    const progress = Math.abs(effectivePrice - pos.entry) / Math.abs(pos.expectedExit - pos.entry);
    if (progress > 0.6 && roi > 0.05) {
      closePosition(pos, effectivePrice, "PARTIAL_REVERSION");
      continue;
    }
  }
}

// ─── REPORTE ──────────────────────────────────────────────────
function printReport(totalMarkets, validCount, rejected) {
  const divider = "─".repeat(60);
  log(divider);
  log(`CICLO ${state.cycle} | Mercados: ${totalMarkets} total, ${validCount} válidos`);
  log(`Rechazados → precio:${rejected.price} vol:${rejected.volume} liq:${rejected.liquidity}`);

  for (const b of ["A", "B", "C"]) {
    const openPos = state.positions.filter(p => p.bot === b);
    const botClosed = state.closed.filter(t => t.bot === b);
    const botWins = botClosed.filter(t => t.pnl > 0).length;
    const botPnl = botClosed.reduce((s, t) => s + t.pnl, 0);
    const wr = botClosed.length ? ((botWins / botClosed.length) * 100).toFixed(0) : "—";

    log(
      `BOT ${b} (${BOTS[b].label}) | ` +
      `equity=$${state.equity[b].toFixed(2)} | ` +
      `pos=${openPos.length}/${CONFIG.MAX_OPEN_PER_BOT} | ` +
      `DD=${(state.dd[b] * 100).toFixed(1)}% | ` +
      `trades=${botClosed.length} WR=${wr}% pnl=$${botPnl.toFixed(2)}`
    );

    for (const p of openPos) {
      const age = Math.round((Date.now() - p.opened) / 60_000);
      log(`  └ ${p.direction} ${p.slug.slice(0, 35)} | entry=${p.entry.toFixed(3)} | age=${age}m`);
    }
  }

  // Stats globales
  const allClosed = state.closed;
  if (allClosed.length > 0) {
    const wins = allClosed.filter(t => t.pnl > 0);
    const losses = allClosed.filter(t => t.pnl < 0);
    const totalPnl = allClosed.reduce((s, t) => s + t.pnl, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    const avgWin = wins.length ? (grossWin / wins.length).toFixed(2) : 0;
    const avgLoss = losses.length ? (grossLoss / losses.length).toFixed(2) : 0;
    const wr = ((wins.length / allClosed.length) * 100).toFixed(1);

    log(`GLOBAL | trades=${allClosed.length} WR=${wr}% PF=${pf} pnl=$${totalPnl.toFixed(2)}`);
    log(`  avg win=$${avgWin} | avg loss=$${avgLoss}`);

    // Desglose por razón de cierre
    const byReason = {};
    for (const t of allClosed) {
      if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 };
      byReason[t.reason].n++;
      byReason[t.reason].pnl += t.pnl;
    }
    for (const [reason, stats] of Object.entries(byReason)) {
      log(`  ${reason}: ${stats.n} trades, pnl=$${stats.pnl.toFixed(2)}`);
    }
  }

  log(divider);
}

// ─── CICLO PRINCIPAL ──────────────────────────────────────────
async function runCycle() {
  state.cycle++;
  const t0 = Date.now();

  try {
    // 1. Fetch
    const allMarkets = await fetchMarkets();
    if (allMarkets.length === 0) {
      log("Sin mercados disponibles, reintentando en siguiente ciclo.", "WARN");
      return;
    }

    // 2. Gestionar posiciones abiertas ANTES de buscar nuevas
    managePositions(allMarkets);

    // 3. Filtrar mercados
    const { valid, rejected } = filterMarkets(allMarkets);

    // 4. Actualizar historia de precios
    updateHistory(valid);

    // 5. Calcular señales para todos los mercados válidos
    const candidates = [];
    for (const m of valid) {
      const signal = computeSignal(m);
      if (signal) candidates.push({ ...m, signal });
    }

    // 6. Asignar mejores candidatos a cada bot (sin repetir mercado)
    const usedSlugs = new Set(state.positions.map(p => p.slug));

    for (const [bot, botConfig] of Object.entries(BOTS)) {
      const eligible = candidates
        .filter(c =>
          !usedSlugs.has(c.slug) &&
          c.signal.absZScore >= botConfig.MIN_ZSCORE &&
          state.equity[bot] > 10
        )
        .sort((a, b) => b.signal.qualScore - a.signal.qualScore);

      if (eligible.length === 0) continue;

      const best = eligible[0];
      openPosition(bot, best, best.signal);
      usedSlugs.add(best.slug);
    }

    // 7. Reporte
    printReport(allMarkets.length, valid.length, rejected);

    const elapsed = Date.now() - t0;
    log(`Ciclo completado en ${elapsed}ms`);

  } catch (err) {
    log(`Error en ciclo: ${err.message}`, "ERR");
    console.error(err.stack);
  } finally {
    saveState();
  }
}

// ─── SCHEDULER ────────────────────────────────────────────────
async function scheduler() {
  const t0 = Date.now();
  await runCycle();
  const elapsed = Date.now() - t0;
  const delay = Math.max(5_000, CONFIG.CYCLE_INTERVAL_MS - elapsed);
  setTimeout(scheduler, delay);
}

// ─── ARRANQUE ─────────────────────────────────────────────────
log("════════════════════════════════════════════════════════════");
log("MICRODRIFT v5.0 — Paper Trading System");
log("Estrategia: Mean Reversion sobre ventana histórica de precios");
log(`Capital: $${CONFIG.INITIAL_EQUITY} × 3 bots = $${CONFIG.INITIAL_EQUITY * 3} total`);
log(`Fees reales: ${(CONFIG.FEE_RATE * 100).toFixed(0)}% por operación`);
log(`Ciclo: cada ${CONFIG.CYCLE_INTERVAL_MS / 60_000} minutos`);
log(`Stop: ${CONFIG.STOP_LOSS_ROI * 100}% | TP: ${CONFIG.TAKE_PROFIT_ROI * 100}%`);
log(`Ventana histórica: ${CONFIG.HISTORY_WINDOW} ciclos | Z-score mín: ver bots`);
log("════════════════════════════════════════════════════════════");
log("AVISO: Esto es PAPER TRADING. No opera con dinero real.");
log("════════════════════════════════════════════════════════════");

scheduler();

process.on("uncaughtException", err => {
  log(`Excepción no capturada: ${err.message}`, "ERR");
  console.error(err.stack);
  saveState();
  process.exit(1);
});

process.on("unhandledRejection", reason => {
  log(`Promesa rechazada: ${reason}`, "ERR");
  saveState();
});

process.on("SIGINT", () => {
  log("Deteniendo sistema...");
  saveState();
  process.exit(0);
});
