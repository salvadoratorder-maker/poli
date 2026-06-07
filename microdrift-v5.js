// ─── LOGGING ──────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function log(msg, level = "INFO") {
  const prefix = level === "WARN" ? "⚠ " : level === "ERR" ? "✖ " : level === "TRADE" ? "◆ " : "  ";
  console.log(`[${ts()}] ${prefix}${msg}`);
}

// ─── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  INITIAL_EQUITY: 200,

  PRICE_MIN: 0.05,
  PRICE_MAX: 0.95,

  MIN_VOLUME_24H: 50_000,
  MIN_LIQ:        20_000,   // umbral base — se escala por scaledMinLiq()

  RISK_PER_TRADE:  0.025,
  MAX_OPEN_PER_BOT: 2,

  FEE_RATE: 0.02,

  STOP_LOSS_ROI:   -0.12,
  TAKE_PROFIT_ROI:  0.25,

  // Mercados con precio de entrada < umbral tienen TP más amplio
  LOW_PRICE_THRESHOLD: 0.15,
  LOW_PRICE_TP_ROI:    0.50,

  MAX_HOLD_MS: 4 * 60 * 60 * 1000,   // 4h

  CYCLE_INTERVAL_MS: 60 * 60 * 1000, // 1h

  // FIX 3: ventana histórica ampliada a 24 ciclos (antes: 6)
  HISTORY_WINDOW:   24,
  MIN_HIST_CYCLES:   6,   // mínimo para calcular z-score fiable

  // FIX 1: filtro de tendencia — no entrar contra tendencia sostenida
  // Si el precio lleva N ciclos moviéndose en la misma dirección, no es reversión
  TREND_WINDOW:     4,    // ciclos para detectar tendencia
  TREND_THRESHOLD:  0.03, // cambio acumulado > 3% en TREND_WINDOW → tendencia activa

  STOP_LOSS_COOLDOWN_CYCLES: 3,
};

const BOTS = {
  A: { MIN_ZSCORE: 2.0, label: "Conservative" },
  B: { MIN_ZSCORE: 2.2, label: "Balanced"     },
  C: { MIN_ZSCORE: 2.5, label: "Aggressive"   },
};

// ─── SUPABASE ─────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("✖ Faltan variables de entorno SUPABASE_URL y/o SUPABASE_KEY");
  process.exit(1);
}

async function sbFetch(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=minimal,resolution=merge-duplicates" : "",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${txt}`);
  }
  if (method === "GET") return res.json();
  return null;
}

async function dbGet(key) {
  try {
    const rows = await sbFetch(`/bot_state?key=eq.${encodeURIComponent(key)}&select=value`);
    if (rows && rows.length > 0) return rows[0].value;
    return null;
  } catch (err) {
    log(`dbGet(${key}) error: ${err.message}`, "ERR");
    return null;
  }
}

async function dbSet(key, value) {
  try {
    await sbFetch("/bot_state?on_conflict=key", "POST", {
      key,
      value,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    log(`dbSet(${key}) error: ${err.message}`, "ERR");
  }
}

async function dbInsertTrade(pos, exitPrice, pnl, roi, reason) {
  try {
    await sbFetch("/trades", "POST", {
      bot:       pos.bot,
      slug:      pos.slug,
      direction: pos.direction,
      entry:     pos.entry,
      exit:      exitPrice,
      invested:  pos.invested,
      pnl,
      roi,
      reason,
      z_score:   pos.zScoreAtEntry || null,
      opened_at: new Date(pos.opened).toISOString(),
      closed_at: new Date().toISOString(),
    });
  } catch (err) {
    log(`dbInsertTrade error: ${err.message}`, "ERR");
  }
}

// ─── ESTADO ───────────────────────────────────────────────────
let state = {
  cycle:            0,
  history:          {},
  positions:        [],
  closed:           [],
  equity:           { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY },
  peak:             { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY },
  dd:               { A: 0, B: 0, C: 0 },
  rejectedHistory:  {},
  auditLog:         [],
  stopLossCooldown: {},
};

// ─── CARGA DE ESTADO ──────────────────────────────────────────
async function loadState() {
  log("Cargando estado desde Supabase...");
  try {
    const [cycle, equity, peak, dd, history, positions, closed, rejHist, auditLog, slCooldown] =
      await Promise.all([
        dbGet("cycle"),
        dbGet("equity"),
        dbGet("peak"),
        dbGet("dd"),
        dbGet("history"),
        dbGet("positions"),
        dbGet("closed"),
        dbGet("rejectedHistory"),
        dbGet("auditLog"),
        dbGet("stopLossCooldown"),
      ]);

    if (cycle      !== null) state.cycle            = cycle;
    if (equity     !== null) state.equity           = equity;
    if (peak       !== null) state.peak             = peak;
    if (dd         !== null) state.dd               = dd;
    if (history    !== null) state.history          = history;
    if (positions  !== null) state.positions        = positions;
    if (closed     !== null) state.closed           = closed;
    if (rejHist    !== null) state.rejectedHistory  = rejHist;
    if (auditLog   !== null) state.auditLog         = auditLog;
    if (slCooldown !== null) state.stopLossCooldown = slCooldown;

    // Recalcular equity desde tabla trades (fuente de verdad)
    try {
      const allTrades = await sbFetch("/trades?select=bot,invested,pnl");
      if (allTrades && allTrades.length > 0) {
        const realEquity = {
          A: CONFIG.INITIAL_EQUITY,
          B: CONFIG.INITIAL_EQUITY,
          C: CONFIG.INITIAL_EQUITY,
        };
        for (const pos of state.positions) realEquity[pos.bot] -= pos.invested;
        for (const t of allTrades) {
          if (realEquity[t.bot] !== undefined) realEquity[t.bot] += t.pnl;
        }
        state.equity = realEquity;
        state.peak = {
          A: Math.max(state.peak.A, realEquity.A),
          B: Math.max(state.peak.B, realEquity.B),
          C: Math.max(state.peak.C, realEquity.C),
        };
        log(`Equity recalculado desde ${allTrades.length} trades → A=$${realEquity.A.toFixed(2)} B=$${realEquity.B.toFixed(2)} C=$${realEquity.C.toFixed(2)}`);
      }
    } catch (eqErr) {
      log(`No se pudo recalcular equity: ${eqErr.message}`, "WARN");
    }

    log(`Estado cargado: ciclo=${state.cycle} trades=${state.closed.length} mercados=${Object.keys(state.history).length}`);
  } catch (err) {
    log(`Error cargando estado, iniciando desde cero: ${err.message}`, "WARN");
  }
}

// ─── GUARDADO DE ESTADO ───────────────────────────────────────
async function saveState() {
  try {
    await Promise.all([
      dbSet("cycle",            state.cycle),
      dbSet("equity",           state.equity),
      dbSet("peak",             state.peak),
      dbSet("dd",               state.dd),
      dbSet("history",          state.history),
      dbSet("positions",        state.positions),
      dbSet("closed",           state.closed),
      dbSet("rejectedHistory",  state.rejectedHistory),
      dbSet("auditLog",         state.auditLog),
      dbSet("stopLossCooldown", state.stopLossCooldown),
    ]);
  } catch (err) {
    log(`saveState error: ${err.message}`, "ERR");
  }
}

// ─── API POLYMARKET ───────────────────────────────────────────
async function fetchMarkets() {
  const url = `${CONFIG.API}/markets?active=true&closed=false&limit=100`;
  const res  = await fetch(url, { headers: { "User-Agent": "DriftBot/4.0" } });
  if (!res.ok) throw new Error(`fetchMarkets HTTP ${res.status}`);
  return res.json();
}

function extractPrice(m) {
  const p = m?.outcomePrices?.[0] ?? m?.lastPrice;
  return p ? parseFloat(p) : null;
}

// ─── ESTADÍSTICAS ─────────────────────────────────────────────
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

// Z-score: desviación del último precio respecto a la media histórica previa
function zScore(arr) {
  if (arr.length < 2) return 0;
  const history = arr.slice(0, -1);  // todo menos el último
  const sd = stddev(history);
  if (sd === 0) return 0;
  return (arr[arr.length - 1] - mean(history)) / sd;
}

// ─── FIX 1: FILTRO DE TENDENCIA ───────────────────────────────
// Una señal de reversión es válida SOLO si el movimiento reciente
// es brusco (spike), no una tendencia sostenida.
// Si el precio lleva TREND_WINDOW ciclos moviéndose en la misma
// dirección con cambio acumulado > TREND_THRESHOLD → no es reversión,
// es información nueva. Rechazamos la señal.
function isActiveTrend(hist) {
  if (hist.length < CONFIG.TREND_WINDOW + 1) return false;
  const recent = hist.slice(-(CONFIG.TREND_WINDOW + 1));
  const start  = recent[0];
  const end    = recent[recent.length - 1];
  const change = (end - start) / start;

  // Comprobar que todos los movimientos internos van en la misma dirección
  let monotonic = true;
  for (let i = 1; i < recent.length; i++) {
    if (change > 0 && recent[i] < recent[i - 1]) { monotonic = false; break; }
    if (change < 0 && recent[i] > recent[i - 1]) { monotonic = false; break; }
  }

  return monotonic && Math.abs(change) > CONFIG.TREND_THRESHOLD;
}

// ─── FIX 2: MATEMÁTICA SELL_PROXY CORRECTA ────────────────────
//
// En Polymarket NO existe venta en corto.
// Cuando detectamos z > 0 (YES anormalmente caro), la operación correcta es:
//   → Comprar NO a precio_NO = 1 - precio_YES
//
// Ejemplo concreto:
//   YES = 0.70 (anormalmente alto, z = +2.1)
//   Compramos NO a 0.30
//   Si YES revierte a 0.55 → NO vale 0.45
//   ROI = (0.45 - 0.30) / 0.30 = +50%
//
// El precio de entrada y salida que guardamos es el del NO (1 - YES).
// El z-score sigue calculándose sobre el historial del YES para detectar
// la anomalía, pero la posición vive en el espacio del NO.

function noPrice(yesPrice) {
  return 1 - yesPrice;
}

// ─── LIQUIDEZ MÍNIMA ESCALADA POR PRECIO ─────────────────────
function scaledMinLiq(price) {
  if (price < 0.10) return CONFIG.MIN_LIQ * 0.5;   // 10k
  if (price < 0.20) return CONFIG.MIN_LIQ * 0.75;  // 15k
  return CONFIG.MIN_LIQ;                             // 20k
}

// ─── TAKE PROFIT SEGÚN PRECIO DE ENTRADA ─────────────────────
function takeProfitForEntry(entryPrice) {
  return entryPrice < CONFIG.LOW_PRICE_THRESHOLD
    ? CONFIG.LOW_PRICE_TP_ROI
    : CONFIG.TAKE_PROFIT_ROI;
}

// ─── COOLDOWN ─────────────────────────────────────────────────
function isInCooldown(slug) {
  const c = state.stopLossCooldown[slug];
  return c !== undefined && (state.cycle - c) < CONFIG.STOP_LOSS_COOLDOWN_CYCLES;
}

function setCooldown(slug) {
  state.stopLossCooldown[slug] = state.cycle;
}

// ─── CIERRE DE POSICIÓN ───────────────────────────────────────
// FIX 2 aplicado aquí: el PnL de BUY y SELL_PROXY se calcula
// sobre el precio real de compra (YES para BUY, NO para SELL_PROXY).
async function closePosition(pos, currentYesPrice, reason) {
  let exitPrice, roi, gross, fee, pnl, netReturn;

  if (pos.direction === "BUY") {
    // Compramos YES. Ganamos cuando YES sube.
    exitPrice = currentYesPrice;
    roi       = (exitPrice - pos.entry) / pos.entry;
    gross     = pos.shares * exitPrice;
    fee       = gross * CONFIG.FEE_RATE;
    pnl       = gross - fee - pos.invested;
    netReturn = pos.invested + pnl;

  } else {
    // SELL_PROXY = compramos NO.
    // pos.entry ya es el precio del NO en el momento de apertura.
    // currentYesPrice → precio actual del YES → NO = 1 - YES
    exitPrice = noPrice(currentYesPrice);  // precio actual del NO
    roi       = (exitPrice - pos.entry) / pos.entry;
    gross     = pos.shares * exitPrice;
    fee       = gross * CONFIG.FEE_RATE;
    pnl       = gross - fee - pos.invested;
    netReturn = pos.invested + pnl;
  }

  state.equity[pos.bot] += netReturn;
  state.peak[pos.bot]    = Math.max(state.peak[pos.bot], state.equity[pos.bot]);
  state.dd[pos.bot]      = (state.peak[pos.bot] - state.equity[pos.bot]) / state.peak[pos.bot];

  if (reason === "STOP_LOSS") setCooldown(pos.slug);

  // Guardamos el exitPrice en el espacio real de la posición (NO o YES)
  await dbInsertTrade(pos, exitPrice, pnl, roi, reason);

  state.closed.push({ ...pos, exit: exitPrice, pnl, roi, reason, closeTime: Date.now() });
  state.positions = state.positions.filter(p => p !== pos);

  log(`◆ CLOSE [${pos.bot}] ${pos.slug} ${pos.direction} ${reason} roi=${(roi * 100).toFixed(1)}% pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`, "TRADE");
}

// ─── GESTIÓN DE POSICIONES ABIERTAS ──────────────────────────
async function managePositions(markets) {
  const now = Date.now();
  for (const pos of [...state.positions]) {
    const market = markets.find(m => m.slug === pos.slug);
    if (!market) continue;

    const currentYesPrice = market.price;

    // ROI calculado sobre el precio real de compra
    let roi;
    if (pos.direction === "BUY") {
      roi = (currentYesPrice - pos.entry) / pos.entry;
    } else {
      // pos.entry = precio del NO en apertura
      // noPrice(currentYesPrice) = precio actual del NO
      roi = (noPrice(currentYesPrice) - pos.entry) / pos.entry;
    }

    const tp = takeProfitForEntry(pos.entry);

    if      (roi <= CONFIG.STOP_LOSS_ROI)     await closePosition(pos, currentYesPrice, "STOP_LOSS");
    else if (roi >= tp)                        await closePosition(pos, currentYesPrice, "TAKE_PROFIT");
    else if (now - pos.opened >= CONFIG.MAX_HOLD_MS) await closePosition(pos, currentYesPrice, "TIMEOUT");
  }
}

// ─── SEÑALES DE ENTRADA ───────────────────────────────────────
async function findSignals(markets) {
  const signals    = [];
  const auditEntry = { ts: Date.now(), cycle: state.cycle, details: [], wouldHaveTP: 0, wouldHaveSignal: 0 };

  for (const market of markets) {
    const { slug, price: yesPrice, volume24h, liquidity } = market;

    // ── Filtros de calidad ──────────────────────────────────
    if (yesPrice < CONFIG.PRICE_MIN || yesPrice > CONFIG.PRICE_MAX) continue;
    if (volume24h < CONFIG.MIN_VOLUME_24H)       continue;
    if (liquidity < scaledMinLiq(yesPrice))      continue;

    // ── Historial suficiente ────────────────────────────────
    const hist = state.history[slug];
    if (!hist || hist.length < CONFIG.MIN_HIST_CYCLES) continue;

    // ── FIX 1: rechazar si hay tendencia sostenida ──────────
    if (isActiveTrend(hist)) {
      auditEntry.details.push({ slug, rejected: "TREND" });
      continue;
    }

    // ── Z-score sobre historial de YES ──────────────────────
    const z    = zScore(hist);
    const absZ = Math.abs(z);

    // ── Dirección ───────────────────────────────────────────
    // z > 0 → YES caro → compramos NO (SELL_PROXY)
    // z < 0 → YES barato → compramos YES (BUY)
    const direction = z > 0 ? "SELL_PROXY" : "BUY";

    // ── Precio real de entrada según dirección ───────────────
    // FIX 2: para SELL_PROXY guardamos el precio del NO, no del YES
    const entryPrice = direction === "SELL_PROXY" ? noPrice(yesPrice) : yesPrice;

    // ── ROI potencial ────────────────────────────────────────
    // La media histórica del YES es nuestro objetivo de reversión
    const histMean = mean(hist.slice(0, -1));
    let potentialRoi;
    if (direction === "BUY") {
      // Compramos YES barato, esperamos que suba a la media
      potentialRoi = (histMean - yesPrice) / yesPrice;
    } else {
      // Compramos NO = (1-YES), esperamos que YES baje a la media
      // → NO sube de (1-yesPrice) a (1-histMean)
      const entryNO = noPrice(yesPrice);
      const exitNO  = noPrice(histMean);
      potentialRoi  = (exitNO - entryNO) / entryNO;
    }

    if (potentialRoi <= 0) continue;  // sin potencial positivo, ignorar
    if (potentialRoi > 0.20) auditEntry.wouldHaveTP++;

    // ── Cooldown ────────────────────────────────────────────
    if (isInCooldown(slug)) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "COOLDOWN" });
      continue;
    }

    // ── Ya tenemos posición en este slug ────────────────────
    if (state.positions.some(p => p.slug === slug)) continue;

    auditEntry.wouldHaveSignal++;

    signals.push({
      slug,
      yesPrice,
      entryPrice,    // precio real de compra (NO o YES)
      z,
      absZ,
      direction,
      potentialRoi,
      volume24h,
      liquidity,
      histMean,
    });

    if (potentialRoi > 0.30) {
      auditEntry.details.push({
        z:     z.toFixed(2),
        roi:   (potentialRoi * 100).toFixed(0) + "%",
        slug,
        entry: entryPrice.toFixed(3),
        dir:   direction,
      });
    }
  }

  state.auditLog.push(auditEntry);
  if (state.auditLog.length > 20) state.auditLog.shift();

  // Ordenar por absZ descendente
  return signals.sort((a, b) => b.absZ - a.absZ);
}

// ─── APERTURA DE POSICIÓN ─────────────────────────────────────
async function openPosition(bot, signal) {
  const equity    = state.equity[bot];
  const invested  = equity * CONFIG.RISK_PER_TRADE;
  if (invested <= 0) return;

  const feeEntry   = invested * CONFIG.FEE_RATE;
  const netInvested = invested - feeEntry;
  // shares calculadas sobre el precio real de compra (NO o YES)
  const shares     = netInvested / signal.entryPrice;

  const pos = {
    bot,
    slug:          signal.slug,
    direction:     signal.direction,
    entry:         signal.entryPrice,  // precio real (NO o YES)
    yesAtEntry:    signal.yesPrice,    // guardamos YES original para referencia
    shares,
    invested,
    opened:        Date.now(),
    cycleOpened:   state.cycle,
    expectedExit:  signal.direction === "SELL_PROXY"
                     ? noPrice(signal.histMean)   // esperamos que NO suba hasta aquí
                     : signal.histMean,            // esperamos que YES suba hasta aquí
    zScoreAtEntry: signal.z,
  };

  state.equity[bot] -= invested;
  state.positions.push(pos);

  log(`◆ OPEN  [${bot}] ${signal.direction} ${signal.slug} entry=${signal.entryPrice.toFixed(3)} (YES=${signal.yesPrice.toFixed(3)}) z=${signal.z.toFixed(2)} potROI=${(signal.potentialRoi * 100).toFixed(0)}%`, "TRADE");
}

// ─── CICLO PRINCIPAL ──────────────────────────────────────────
async function runCycle() {
  state.cycle++;
  log(`─── Ciclo ${state.cycle} ───────────────────────────────────`);

  // 1. Obtener mercados
  let rawMarkets;
  try {
    rawMarkets = await fetchMarkets();
  } catch (err) {
    log(`fetchMarkets falló: ${err.message}`, "ERR");
    return;
  }

  // 2. Parsear y filtrar
  const markets = rawMarkets
    .map(m => ({
      slug:      m.slug,
      price:     extractPrice(m),
      volume24h: Number(m.volume24hr || 0),
      liquidity: Number(m.liquidity  || 0),
    }))
    .filter(m => m.price !== null && m.price > 0);

  log(`Mercados: ${rawMarkets.length} total, ${markets.length} con precio válido`);

  // 3. Actualizar historial (FIX 3: ventana de 24 ciclos)
  for (const m of markets) {
    if (!state.history[m.slug]) state.history[m.slug] = [];
    state.history[m.slug].push(m.price);
    if (state.history[m.slug].length > CONFIG.HISTORY_WINDOW + 4) {
      state.history[m.slug].shift();
    }
  }

  // 4. Gestionar posiciones abiertas
  await managePositions(markets);

  // 5. Buscar señales
  const signals = await findSignals(markets);
  log(`Señales válidas: ${signals.length}`);

  // 6. Asignar señales a bots
  for (const [botId, botCfg] of Object.entries(BOTS)) {
    const openCount = state.positions.filter(p => p.bot === botId).length;
    if (openCount >= CONFIG.MAX_OPEN_PER_BOT) continue;

    const slots = CONFIG.MAX_OPEN_PER_BOT - openCount;

    const validSignals = signals.filter(s =>
      s.absZ >= botCfg.MIN_ZSCORE &&
      !state.positions.some(p => p.bot === botId && p.slug === s.slug)
    );

    for (let i = 0; i < Math.min(slots, validSignals.length); i++) {
      await openPosition(botId, validSignals[i]);
    }
  }

  // 7. Resumen
  for (const b of ["A", "B", "C"]) {
    const open = state.positions.filter(p => p.bot === b).length;
    const pnl  = state.equity[b] - CONFIG.INITIAL_EQUITY;
    log(`[${b}] equity=$${state.equity[b].toFixed(2)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pos=${open} dd=${(state.dd[b] * 100).toFixed(2)}%`);
  }

  // 8. Guardar
  await saveState();
}

// ─── BUCLE ────────────────────────────────────────────────────
async function main() {
  await loadState();

  async function loop() {
    const start = Date.now();
    try {
      await runCycle();
    } catch (err) {
      log(`runCycle error: ${err.message}`, "ERR");
    }
    const elapsed = Date.now() - start;
    const wait    = Math.max(5_000, CONFIG.CYCLE_INTERVAL_MS - elapsed);
    log(`Próximo ciclo en ${Math.round(wait / 1000)}s`);
    setTimeout(loop, wait);
  }

  loop();
}

process.on("uncaughtException", async (err) => {
  log(`uncaughtException: ${err.message}`, "ERR");
  await saveState();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  log(`unhandledRejection: ${reason}`, "ERR");
  await saveState();
});

main();
