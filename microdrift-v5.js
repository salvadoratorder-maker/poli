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
  MIN_LIQ:        20_000,

  RISK_PER_TRADE:   0.025,
  MAX_OPEN_PER_BOT: 2,

  FEE_RATE: 0.02,

  // Mercados con precio YES > HIGH_PRICE_THRESHOLD tienen TP reducido
  // (poco margen para que el NO suba mucho)
  HIGH_PRICE_THRESHOLD: 0.80,
  HIGH_PRICE_TP_FACTOR: 0.6,   // multiplica el TP del bot en mercados muy altos

  MAX_HOLD_MS: 4 * 60 * 60 * 1000,   // 4h

  CYCLE_INTERVAL_MS: 60 * 60 * 1000, // 1h

  HISTORY_WINDOW:   24,
  MIN_HIST_CYCLES:   6,

  // Filtro de tendencia
  TREND_WINDOW:     4,
  TREND_THRESHOLD:  0.03,

  // Cooldown tras stop loss
  STOP_LOSS_COOLDOWN_CYCLES: 3,
};

// ─── BOTS ─────────────────────────────────────────────────────
// Los tres bots operan ÚNICAMENTE SELL_PROXY (comprar NO).
// El edge demostrado en los datos es: precio YES anormalmente alto
// → comprar NO → esperar reversión a la media.
//
// Bot A — base, entrada con z >= 2.0, TP 25%
// Bot B — selectivo, z >= 2.3, TP 35% (deja correr más la reversión)
// Bot C — oportunista, z >= 2.8, TP 50% (espera señales tipo Weinstein)
const BOTS = {
  A: { MIN_ZSCORE: 2.0, TAKE_PROFIT_ROI: 0.25, STOP_LOSS_ROI: -0.12, label: "Base"        },
  B: { MIN_ZSCORE: 2.3, TAKE_PROFIT_ROI: 0.35, STOP_LOSS_ROI: -0.10, label: "Selectivo"   },
  C: { MIN_ZSCORE: 2.8, TAKE_PROFIT_ROI: 0.50, STOP_LOSS_ROI: -0.08, label: "Oportunista" },
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
  const res  = await fetch(url, { headers: { "User-Agent": "DriftBot/5.0" } });
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

function zScore(arr) {
  if (arr.length < 2) return 0;
  const history = arr.slice(0, -1);
  const sd = stddev(history);
  if (sd === 0) return 0;
  return (arr[arr.length - 1] - mean(history)) / sd;
}

// ─── FILTRO DE TENDENCIA ──────────────────────────────────────
// Rechaza señales donde el precio lleva N ciclos subiendo
// de forma monotónica y sostenida — no es reversión, es información.
function isActiveTrend(hist) {
  if (hist.length < CONFIG.TREND_WINDOW + 1) return false;
  const recent = hist.slice(-(CONFIG.TREND_WINDOW + 1));
  const change = (recent[recent.length - 1] - recent[0]) / recent[0];
  let monotonic = true;
  for (let i = 1; i < recent.length; i++) {
    if (change > 0 && recent[i] < recent[i - 1]) { monotonic = false; break; }
    if (change < 0 && recent[i] > recent[i - 1]) { monotonic = false; break; }
  }
  return monotonic && Math.abs(change) > CONFIG.TREND_THRESHOLD;
}

// ─── PRECIO NO ────────────────────────────────────────────────
function noPrice(yesPrice) {
  return 1 - yesPrice;
}

// ─── LIQUIDEZ MÍNIMA ESCALADA ─────────────────────────────────
function scaledMinLiq(price) {
  if (price < 0.10) return CONFIG.MIN_LIQ * 0.5;   // 10k
  if (price < 0.20) return CONFIG.MIN_LIQ * 0.75;  // 15k
  return CONFIG.MIN_LIQ;                             // 20k
}

// ─── TP AJUSTADO POR PRECIO YES ───────────────────────────────
// Si YES está muy alto (ej. 0.90), el NO está a 0.10 y tiene
// poco recorrido relativo. Reducimos el TP para ser más realistas.
function adjustedTP(botTP, yesPrice) {
  if (yesPrice > CONFIG.HIGH_PRICE_THRESHOLD) {
    return botTP * CONFIG.HIGH_PRICE_TP_FACTOR;
  }
  return botTP;
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
// exitPrice = precio del NO al cierre   = 1 - YES_cierre
async function closePosition(pos, currentYesPrice, reason) {
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
    const market = markets.find(m => m.slug === pos.slug);
    if (!market) continue;

    const currentYesPrice = market.price;
    const currentNOPrice  = noPrice(currentYesPrice);
    const roi             = (currentNOPrice - pos.entry) / pos.entry;

    const botCfg = BOTS[pos.bot];
    const tp     = adjustedTP(botCfg.TAKE_PROFIT_ROI, pos.yesAtEntry);
    const sl     = botCfg.STOP_LOSS_ROI;

    if      (roi <= sl)                              await closePosition(pos, currentYesPrice, "STOP_LOSS");
    else if (roi >= tp)                              await closePosition(pos, currentYesPrice, "TAKE_PROFIT");
    else if (now - pos.opened >= CONFIG.MAX_HOLD_MS) await closePosition(pos, currentYesPrice, "TIMEOUT");
  }
}

// ─── SEÑALES DE ENTRADA ───────────────────────────────────────
async function findSignals(markets) {
  const signals    = [];
  const auditEntry = {
    ts:               Date.now(),
    cycle:            state.cycle,
    details:          [],
    wouldHaveSignal:  0,
    wouldHaveTP:      0,
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

    // ── Solo nos interesan señales alcistas en YES (z > 0)
    // porque solo operamos SELL_PROXY (compramos NO)
    const z = zScore(hist);
    if (z <= 0) continue;  // precio bajo → no es nuestra señal

    // ── Filtro de tendencia ─────────────────────────────────
    if (isActiveTrend(hist)) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "TREND" });
      continue;
    }

    // ── ROI potencial del NO ────────────────────────────────
    // Si YES revierte a la media, NO sube de (1-YES) a (1-media)
    const histMean   = mean(hist.slice(0, -1));
    const entryNO    = noPrice(yesPrice);
    const exitNO     = noPrice(histMean);
    const potentialRoi = (exitNO - entryNO) / entryNO;

    if (potentialRoi <= 0) continue;
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
      entryPrice:   entryNO,
      z,
      potentialRoi,
      volume24h,
      liquidity,
      histMean,
    });

    if (potentialRoi > 0.30) {
      auditEntry.details.push({
        slug,
        z:     z.toFixed(2),
        roi:   (potentialRoi * 100).toFixed(0) + "%",
        entry: entryNO.toFixed(3),
      });
    }
  }

  state.auditLog.push(auditEntry);
  if (state.auditLog.length > 20) state.auditLog.shift();

  // Ordenar por z descendente — señal más fuerte primero
  return signals.sort((a, b) => b.z - a.z);
}

// ─── APERTURA DE POSICIÓN ─────────────────────────────────────
async function openPosition(bot, signal) {
  const equity     = state.equity[bot];
  const invested   = equity * CONFIG.RISK_PER_TRADE;
  if (invested <= 0) return;

  const feeEntry    = invested * CONFIG.FEE_RATE;
  const netInvested = invested - feeEntry;
  const shares      = netInvested / signal.entryPrice;

  const pos = {
    bot,
    slug:          signal.slug,
    direction:     "SELL_PROXY",
    entry:         signal.entryPrice,   // precio del NO
    yesAtEntry:    signal.yesPrice,     // YES original (para ajuste de TP)
    shares,
    invested,
    opened:        Date.now(),
    cycleOpened:   state.cycle,
    expectedExit:  noPrice(signal.histMean),
    zScoreAtEntry: signal.z,
  };

  state.equity[bot] -= invested;
  state.positions.push(pos);

  const botCfg = BOTS[bot];
  log(`◆ OPEN  [${bot}/${botCfg.label}] SELL_PROXY ${signal.slug} NO=${signal.entryPrice.toFixed(3)} YES=${signal.yesPrice.toFixed(3)} z=${signal.z.toFixed(2)} potROI=${(signal.potentialRoi * 100).toFixed(0)}%`, "TRADE");
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

  // 4. Gestionar posiciones abiertas
  await managePositions(markets);

  // 5. Buscar señales (solo SELL_PROXY)
  const signals = await findSignals(markets);
  log(`Señales SELL_PROXY válidas: ${signals.length}`);
  if (signals.length > 0) {
    signals.slice(0, 5).forEach(s =>
      log(`  ${s.slug} YES=${s.yesPrice.toFixed(3)} z=${s.z.toFixed(2)} potROI=${(s.potentialRoi * 100).toFixed(0)}%`)
    );
  }

  // 6. Asignar señales a bots
  for (const [botId, botCfg] of Object.entries(BOTS)) {
    const openCount = state.positions.filter(p => p.bot === botId).length;
    if (openCount >= CONFIG.MAX_OPEN_PER_BOT) continue;

    const slots = CONFIG.MAX_OPEN_PER_BOT - openCount;

    // Cada bot filtra por su propio MIN_ZSCORE
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
    log(`[${b}/${cfg.label}] equity=$${state.equity[b].toFixed(2)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pos=${open} dd=${(state.dd[b] * 100).toFixed(2)}% minZ=${cfg.MIN_ZSCORE} TP=${(cfg.TAKE_PROFIT_ROI * 100).toFixed(0)}%`);
  }

  // 8. Guardar
  await saveState();
}

// ─── BUCLE ────────────────────────────────────────────────────
async function main() {
  log("🚀 DriftBot v5.0 — Solo SELL_PROXY, tres perfiles");
  log(`   A/Base:        z>=${BOTS.A.MIN_ZSCORE} TP=${BOTS.A.TAKE_PROFIT_ROI*100}% SL=${Math.abs(BOTS.A.STOP_LOSS_ROI)*100}%`);
  log(`   B/Selectivo:   z>=${BOTS.B.MIN_ZSCORE} TP=${BOTS.B.TAKE_PROFIT_ROI*100}% SL=${Math.abs(BOTS.B.STOP_LOSS_ROI)*100}%`);
  log(`   C/Oportunista: z>=${BOTS.C.MIN_ZSCORE} TP=${BOTS.C.TAKE_PROFIT_ROI*100}% SL=${Math.abs(BOTS.C.STOP_LOSS_ROI)*100}%`);

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
