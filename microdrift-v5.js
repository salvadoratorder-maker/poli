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

  INITIAL_EQUITY: 300,  // $600 total repartido entre A y B

  PRICE_MIN: 0.05,
  PRICE_MAX: 0.95,

  MIN_VOLUME_24H: 50_000,
  MIN_LIQ:        20_000,

  RISK_PER_TRADE:   0.025,
  MAX_OPEN_PER_BOT: 2,

  FEE_RATE: 0.005,

  // BUG FIX: timeout aumentado de 4h → 16h
  // Los trades #2,#5,#6,#7,#8 salieron por timeout antes de revertir
  MAX_HOLD_MS: 12 * 60 * 60 * 1000,

  CYCLE_INTERVAL_MS: 60 * 60 * 1000,

  HISTORY_WINDOW:  12,
  MIN_HIST_CYCLES:  6,

  // FIX: filtro de tendencia eliminado — reemplazado por
  // detección de tendencia BAJISTA como señal positiva (ver findSignals)
  // Una caída sostenida en YES es buena señal para comprar NO

  STOP_LOSS_COOLDOWN_CYCLES: 3,

  // Clasificación de mercados por slug keyword
  // Diferentes hold times y parámetros según tipo
  MARKET_TYPES: {
    SPORTS:   { keywords: ["nba","nfl","nhl","mlb","finals","championship","cup","win","champion"], hold: 8  * 3600_000 },
    POLITICS: { keywords: ["president","election","senate","congress","vote","law","bill","ban"],   hold: 24 * 3600_000 },
    LEGAL:    { keywords: ["guilty","sentenced","verdict","trial","prison","years","weinstein"],    hold: 48 * 3600_000 },
    DEFAULT:  { keywords: [],                                                                        hold: 16 * 3600_000 },
  },
};

// ─── BOTS — solo SELL_PROXY, dos perfiles ────────────────────
//
// Bot C eliminado: con pocos datos históricos, tres bots operando
// el mismo universo de mercados generan correlación total de pérdidas.
// Con dos bots y capital repartido al 50% obtenemos mejor diversificación.
//
// Bot A — base:      z≥2.0, sale en reversión parcial  (z≤0.5)
// Bot B — selectivo: z≥2.4, sale en reversión avanzada (z≤0.3)
//
// Capital inicial por bot: $300 (repartido desde los $600 totales)
//
// TP_Z_TARGET: cerrar cuando el z-score del mercado baje a este valor.
// Entramos por anomalía estadística → salimos cuando la anomalía desaparece.
const BOTS = {
  A: { MIN_ZSCORE: 2.0, TP_Z_TARGET: 0.5, STOP_LOSS_ROI: -0.12, label: "Base"      },
  B: { MIN_ZSCORE: 2.4, TP_Z_TARGET: 0.3, STOP_LOSS_ROI: -0.10, label: "Selectivo" },
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
      z_score:   pos.zScoreAtEntry ?? null,
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
  equity:           { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY },
  peak:             { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY },
  dd:               { A: 0, B: 0 },
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
        dbGet("cycle"),   dbGet("equity"),  dbGet("peak"),
        dbGet("dd"),      dbGet("history"), dbGet("positions"),
        dbGet("closed"),  dbGet("rejectedHistory"),
        dbGet("auditLog"),dbGet("stopLossCooldown"),
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

    // BUG FIX: migrar posiciones BUY de versiones anteriores
    // Cualquier posición con direction="BUY" no es válida en v6
    const buyPositions = state.positions.filter(p => p.direction === "BUY");
    if (buyPositions.length > 0) {
      log(`⚠ Migrando ${buyPositions.length} posiciones BUY de versión anterior — se cerrarán en el primer ciclo`, "WARN");
      // Las marcamos para cierre forzado
      for (const pos of buyPositions) {
        pos._forceMigrationClose = true;
      }
    }

    // Recalcular equity desde tabla trades
    try {
      const allTrades = await sbFetch("/trades?select=bot,invested,pnl");
      if (allTrades && allTrades.length > 0) {
        const realEquity = {
          A: CONFIG.INITIAL_EQUITY,
          B: CONFIG.INITIAL_EQUITY,
        };
        for (const pos of state.positions.filter(p => !p._forceMigrationClose)) {
          if (realEquity[pos.bot] !== undefined) realEquity[pos.bot] -= pos.invested;
        }
        for (const t of allTrades) {
          if (realEquity[t.bot] !== undefined) realEquity[t.bot] += t.pnl;
        }
        state.equity = realEquity;
        state.peak = {
          A: Math.max(state.peak.A ?? CONFIG.INITIAL_EQUITY, realEquity.A),
          B: Math.max(state.peak.B ?? CONFIG.INITIAL_EQUITY, realEquity.B),
        };
        log(`Equity recalculado desde ${allTrades.length} trades → A=$${realEquity.A.toFixed(2)} B=$${realEquity.B.toFixed(2)}`);
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
  const res  = await fetch(url, { headers: { "User-Agent": "DriftBot/6.0" } });
  if (!res.ok) throw new Error(`fetchMarkets HTTP ${res.status}`);
  return res.json();
}

function extractPrice(m) {
  const p = m?.outcomePrices?.[0] ?? m?.lastPrice;
  return p ? parseFloat(p) : null;
}

// ─── TIPO DE MERCADO ──────────────────────────────────────────
function detectMarketType(slug) {
  const s = slug.toLowerCase();
  for (const [type, cfg] of Object.entries(CONFIG.MARKET_TYPES)) {
    if (type === "DEFAULT") continue;
    if (cfg.keywords.some(k => s.includes(k))) return { type, holdMs: cfg.hold };
  }
  return { type: "DEFAULT", holdMs: CONFIG.MARKET_TYPES.DEFAULT.hold };
}

// ─── ESTADÍSTICAS ─────────────────────────────────────────────
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function zScore(arr) {
  if (arr.length < 2) return 0;
  const history = arr.slice(0, -1);
  const sd = stddev(history);
  if (sd === 0) return 0;
  return (arr[arr.length - 1] - mean(history)) / sd;
}

// ─── PRECIO NO ────────────────────────────────────────────────
function noPrice(yesPrice) {
  return 1 - yesPrice;
}

// ─── LIQUIDEZ MÍNIMA ESCALADA ─────────────────────────────────
function scaledMinLiq(price) {
  if (price < 0.10) return CONFIG.MIN_LIQ * 0.5;
  if (price < 0.20) return CONFIG.MIN_LIQ * 0.75;
  return CONFIG.MIN_LIQ;
}

// ─── STOP LOSS DINÁMICO ───────────────────────────────────────
// SL basado en el precio real del NO: mínimo del 8% del bot
// o un 30% del precio de entrada del NO (para entradas muy bajas
// donde un SL fijo del 12% sería demasiado ajustado)
function dynamicSL(botSL, entryNO) {
  const priceBased = -(entryNO * 0.30);
  return Math.min(botSL, priceBased);  // el más restrictivo (menos negativo)
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
// Toda posición es SELL_PROXY = compramos NO.
// pos.entry = precio del NO en apertura = 1 - YES_apertura
// exitPrice  = precio del NO al cierre  = 1 - YES_cierre
async function closePosition(pos, currentYesPrice, reason) {
  // BUG FIX: si por migración la posición es BUY, cerrar al precio actual
  // sin cálculo de PnL de NO (registrar como migración)
  if (pos.direction === "BUY") {
    const pnl = 0;
    await dbInsertTrade(pos, currentYesPrice, pnl, 0, "MIGRATION_CLOSE");
    state.equity[pos.bot] += pos.invested; // devolver capital sin pérdida (ya contabilizado)
    state.positions = state.positions.filter(p => p !== pos);
    log(`⚠ MIGRATION_CLOSE [${pos.bot}] ${pos.slug} — posición BUY de versión anterior cerrada`, "WARN");
    return;
  }

  const exitPrice = noPrice(currentYesPrice);
  const roi       = (exitPrice - pos.entry) / pos.entry;
  const gross     = pos.shares * exitPrice;
  const fee       = gross * CONFIG.FEE_RATE;
  const pnl       = gross - fee - pos.invested;
  const netReturn = pos.invested + pnl;

  state.equity[pos.bot] += netReturn;
  state.peak[pos.bot]    = Math.max(state.peak[pos.bot], state.equity[pos.bot]);
  state.dd[pos.bot]      = (state.peak[pos.bot] - state.equity[pos.bot]) / state.peak[pos.bot];

  if (reason === "STOP_LOSS") setCooldown(pos.slug);

  await dbInsertTrade(pos, exitPrice, pnl, roi, reason);

  state.closed.push({ ...pos, exit: exitPrice, pnl, roi, reason, closeTime: Date.now() });
  state.positions = state.positions.filter(p => p !== pos);

  log(`◆ CLOSE [${pos.bot}] ${pos.slug} ${reason} roi=${(roi * 100).toFixed(1)}% pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`, "TRADE");
}

// ─── GESTIÓN DE POSICIONES ABIERTAS ──────────────────────────
async function managePositions(markets) {
  const now = Date.now();
  for (const pos of [...state.positions]) {

    // BUG FIX: cerrar posiciones BUY de versiones anteriores
    if (pos._forceMigrationClose || pos.direction === "BUY") {
      const market = markets.find(m => m.slug === pos.slug);
      const price  = market ? market.price : (pos.yesAtEntry ?? pos.entry);
      await closePosition(pos, price, "MIGRATION_CLOSE");
      continue;
    }

    const market = markets.find(m => m.slug === pos.slug);
    if (!market) continue;

    const currentYesPrice = market.price;
    const currentNOPrice  = noPrice(currentYesPrice);
    const roi             = (currentNOPrice - pos.entry) / pos.entry;

    const botCfg = BOTS[pos.bot];
    const sl     = dynamicSL(botCfg.STOP_LOSS_ROI, pos.entry);

    // FIX: TP basado en z-score, no en ROI fijo
    // Cerramos cuando la anomalía se ha disipado (z vuelve al umbral del bot)
    const hist        = state.history[pos.slug];
    const currentZ    = hist ? zScore(hist) : pos.zScoreAtEntry;
    const tpTriggered = currentZ <= botCfg.TP_Z_TARGET;

    // Hold time según tipo de mercado
    const holdMs = pos.marketHoldMs ?? CONFIG.MAX_HOLD_MS;

    if (roi <= sl) {
      await closePosition(pos, currentYesPrice, "STOP_LOSS");
    } else if (tpTriggered && roi > 0) {
      // Solo salimos por z-score si tenemos PnL positivo
      await closePosition(pos, currentYesPrice, "TAKE_PROFIT");
    } else if (now - pos.opened >= holdMs) {
      await closePosition(pos, currentYesPrice, "TIMEOUT");
    }
  }
}

// ─── SEÑALES DE ENTRADA ───────────────────────────────────────
async function findSignals(markets) {
  const signals    = [];
  const auditEntry = {
    ts: Date.now(), cycle: state.cycle,
    details: [], wouldHaveSignal: 0, wouldHaveTP: 0,
  };

  for (const market of markets) {
    const { slug, price: yesPrice, volume24h, liquidity } = market;

    // ── Filtros de calidad ──────────────────────────────────
    if (yesPrice < CONFIG.PRICE_MIN || yesPrice > CONFIG.PRICE_MAX) continue;
    if (volume24h < CONFIG.MIN_VOLUME_24H)   continue;
    if (liquidity < scaledMinLiq(yesPrice))  continue;

    // ── Historial suficiente ────────────────────────────────
    const hist = state.history[slug];
    if (!hist || hist.length < CONFIG.MIN_HIST_CYCLES) continue;

    // ── Solo señales con z > 0 (YES anormalmente alto → comprar NO)
    const z = zScore(hist);
    if (z <= 0) continue;

    // ── FIX: reemplazamos el filtro de tendencia por detección
    // de tendencia BAJISTA como confirmación adicional de señal.
    // Si YES lleva bajando los últimos N ciclos, es señal de que
    // el mercado ya está corrigiendo — confirmamos la entrada.
    // Si YES lleva subiendo (tendencia alcista fuerte), esperamos
    // a que se forme el pico antes de entrar.
    const recentWindow = hist.slice(-4);
    const recentChange = (recentWindow[recentWindow.length - 1] - recentWindow[0]) / recentWindow[0];
    const isConfirmedReverting = recentChange < -0.01; // YES bajando ≥ 1% en 4 ciclos
    const isStillRising        = recentChange >  0.05; // YES subiendo > 5% (evitamos picos en formación)

    // Señal fuerte: z alto Y precio ya revirtiendo
    // Señal débil: z alto pero precio aún sube (podría subir más, esperamos)
    const signalStrength = isConfirmedReverting ? "STRONG" : isStillRising ? "WEAK" : "NORMAL";

    if (signalStrength === "WEAK") {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "STILL_RISING" });
      continue;
    }

    // ── ROI potencial del NO ────────────────────────────────
    const histMean     = mean(hist.slice(0, -1));
    const entryNO      = noPrice(yesPrice);
    const exitNO       = noPrice(histMean);
    const potentialRoi = (exitNO - entryNO) / entryNO;

    if (potentialRoi <= 0) continue;
    if (potentialRoi > 0.20) auditEntry.wouldHaveTP++;

    // ── Cooldown ────────────────────────────────────────────
    if (isInCooldown(slug)) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "COOLDOWN" });
      continue;
    }

    // ── Ya tenemos posición ─────────────────────────────────
    if (state.positions.some(p => p.slug === slug)) continue;

    auditEntry.wouldHaveSignal++;

    const { type: marketType, holdMs: marketHoldMs } = detectMarketType(slug);

    signals.push({
      slug,
      yesPrice,
      entryPrice: entryNO,
      z,
      potentialRoi,
      volume24h,
      liquidity,
      histMean,
      signalStrength,
      marketType,
      marketHoldMs,
    });

    if (potentialRoi > 0.25) {
      auditEntry.details.push({
        slug, z: z.toFixed(2),
        roi:   (potentialRoi * 100).toFixed(0) + "%",
        entry: entryNO.toFixed(3),
        type:  marketType,
        strength: signalStrength,
      });
    }
  }

  state.auditLog.push(auditEntry);
  if (state.auditLog.length > 20) state.auditLog.shift();

  // Ordenar: STRONG primero, luego por z descendente
  return signals.sort((a, b) => {
    if (a.signalStrength === "STRONG" && b.signalStrength !== "STRONG") return -1;
    if (b.signalStrength === "STRONG" && a.signalStrength !== "STRONG") return  1;
    return b.z - a.z;
  });
}

// ─── APERTURA DE POSICIÓN ─────────────────────────────────────
async function openPosition(bot, signal) {
  const equity     = state.equity[bot];
  const invested   = equity * CONFIG.RISK_PER_TRADE;
  if (invested <= 0) return;

  const feeEntry    = invested * CONFIG.FEE_RATE;
  const netInvested = invested - feeEntry;
  const shares      = netInvested / signal.entryPrice;

  // BUG FIX: direction siempre SELL_PROXY, nunca BUY
  const pos = {
    bot,
    slug:          signal.slug,
    direction:     "SELL_PROXY",          // forzado — nunca BUY en v6
    entry:         signal.entryPrice,      // precio del NO
    yesAtEntry:    signal.yesPrice,        // YES original (referencia)
    shares,
    invested,
    opened:        Date.now(),
    cycleOpened:   state.cycle,
    expectedExit:  noPrice(signal.histMean),
    zScoreAtEntry: signal.z,               // siempre positivo (z > 0 filtrado en findSignals)
    marketType:    signal.marketType,
    marketHoldMs:  signal.marketHoldMs,
    signalStrength: signal.signalStrength,
  };

  state.equity[bot] -= invested;
  state.positions.push(pos);

  const botCfg = BOTS[bot];
  log(`◆ OPEN  [${bot}/${botCfg.label}] SELL_PROXY ${signal.slug} NO=${signal.entryPrice.toFixed(3)} YES=${signal.yesPrice.toFixed(3)} z=${signal.z.toFixed(2)} ${signal.signalStrength} ${signal.marketType} potROI=${(signal.potentialRoi * 100).toFixed(0)}%`, "TRADE");
}

// ─── CICLO PRINCIPAL ──────────────────────────────────────────
async function runCycle() {
  state.cycle++;
  log(`─── Ciclo ${state.cycle} ────────────────────────────────────`);

  // 1. Obtener mercados
  let rawMarkets;
  try {
    rawMarkets = await fetchMarkets();
  } catch (err) {
    log(`fetchMarkets falló: ${err.message}`, "ERR");
    return;
  }

  // 2. Parsear
  const markets = rawMarkets
    .map(m => ({
      slug:      m.slug,
      price:     extractPrice(m),
      volume24h: Number(m.volume24hr || 0),
      liquidity: Number(m.liquidity  || 0),
    }))
    .filter(m => m.price !== null && m.price > 0);

  log(`Mercados: ${rawMarkets.length} total, ${markets.length} con precio válido`);

  // 3. Actualizar historial (ventana 24 ciclos)
  for (const m of markets) {
    if (!state.history[m.slug]) state.history[m.slug] = [];
    state.history[m.slug].push(m.price);
    if (state.history[m.slug].length > CONFIG.HISTORY_WINDOW + 4) {
      state.history[m.slug].shift();
    }
  }

  // 4. Gestionar posiciones abiertas (incluye migración de BUY)
  await managePositions(markets);

  // 5. Buscar señales
  const signals = await findSignals(markets);
  const strong  = signals.filter(s => s.signalStrength === "STRONG").length;
  log(`Señales: ${signals.length} total (${strong} STRONG)`);
  if (signals.length > 0) {
    signals.slice(0, 5).forEach(s =>
      log(`  [${s.signalStrength}/${s.marketType}] ${s.slug} YES=${s.yesPrice.toFixed(3)} z=${s.z.toFixed(2)} potROI=${(s.potentialRoi * 100).toFixed(0)}%`)
    );
  }

  // 6. Asignar señales a bots
  for (const [botId, botCfg] of Object.entries(BOTS)) {
    const openCount = state.positions.filter(p => p.bot === botId).length;
    if (openCount >= CONFIG.MAX_OPEN_PER_BOT) continue;

    const slots = CONFIG.MAX_OPEN_PER_BOT - openCount;

    const validSignals = signals.filter(s =>
      s.z >= botCfg.MIN_ZSCORE &&
      !state.positions.some(p => p.bot === botId && p.slug === s.slug)
    );

    for (let i = 0; i < Math.min(slots, validSignals.length); i++) {
      await openPosition(botId, validSignals[i]);
    }
  }

  // 7. Resumen
  log(`─── Estado ──────────────────────────────────────────────`);
  for (const [b, cfg] of Object.entries(BOTS)) {
    const open = state.positions.filter(p => p.bot === b).length;
    const pnl  = state.equity[b] - CONFIG.INITIAL_EQUITY;
    log(`[${b}/${cfg.label}] equity=$${state.equity[b].toFixed(2)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pos=${open} dd=${(state.dd[b] * 100).toFixed(2)}% z_tp≤${cfg.TP_Z_TARGET} sl=${Math.abs(cfg.STOP_LOSS_ROI * 100).toFixed(0)}%`);
  }
  const total = Object.values(state.equity).reduce((a, b) => a + b, 0);
  log(`[TOTAL] equity=$${total.toFixed(2)} pnl=${(total - CONFIG.INITIAL_EQUITY * 2) >= 0 ? "+" : ""}${(total - CONFIG.INITIAL_EQUITY * 2).toFixed(2)}`);
  const openPos = state.positions.filter(p => p.direction !== "BUY");
  if (openPos.length > 0) {
    log(`─── Posiciones abiertas ─────────────────────────────────`);
    for (const pos of openPos) {
      const market = markets.find(m => m.slug === pos.slug);
      if (!market) continue;
      const currentNO = noPrice(market.price);
      const roi       = (currentNO - pos.entry) / pos.entry;
      const age       = Math.round((Date.now() - pos.opened) / 3600_000);
      log(`  [${pos.bot}] ${pos.slug} NO:${pos.entry.toFixed(3)}→${currentNO.toFixed(3)} roi=${(roi * 100).toFixed(1)}% age=${age}h ${pos.marketType}`);
    }
  }

  // 8. Guardar
  await saveState();
}

// ─── BUCLE ────────────────────────────────────────────────────
async function main() {
  log("🚀 DriftBot v7.0 — SELL_PROXY · 2 bots · historial 12h · hold 12h");
  log(`   A/Base:      z>=${BOTS.A.MIN_ZSCORE} TP z≤${BOTS.A.TP_Z_TARGET} SL ${Math.abs(BOTS.A.STOP_LOSS_ROI * 100)}% equity=$${CONFIG.INITIAL_EQUITY}`);
  log(`   B/Selectivo: z>=${BOTS.B.MIN_ZSCORE} TP z≤${BOTS.B.TP_Z_TARGET} SL ${Math.abs(BOTS.B.STOP_LOSS_ROI * 100)}% equity=$${CONFIG.INITIAL_EQUITY}`);

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
