// ─── LOGGING ──────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function log(msg, level = "INFO") {
  const prefix = level === "WARN" ? "⚠ " : level === "ERR" ? "✖ " : level === "TRADE" ? "◆ " : "  ";
  console.log(`[${ts()}] ${prefix}${msg}`);
}

// ─── CONFIvG ──────────────────────────────────────────────────
const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  INITIAL_EQUITY: 200,

  PRICE_MIN: 0.05, // Lowered from 0.10
  PRICE_MAX: 0.95, // Lowered from 0.90
  MIN_VOLUME_24H: 50_000,
  MIN_LIQ: 20_000,

  RISK_PER_TRADE: 0.025,
  MAX_OPEN_PER_BOT: 2,

  FEE_RATE: 0.02,

  STOP_LOSS_ROI: -0.12,
  TAKE_PROFIT_ROI: 0.20,
  MAX_HOLD_MS: 2 * 60 * 60 * 1000,

  CYCLE_INTERVAL_MS: 60 * 60 * 1000,

  HISTORY_WINDOW: 6,
  REVERSION_THRESHOLD: 1.8,
  MIN_HIST_CYCLES: 3,
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
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=minimal,resolution=merge-duplicates" : "",
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

// Lee una clave de bot_state
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

// Escribe/actualiza una clave en bot_state (upsert)
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

// Inserta un trade cerrado en la tabla trades
async function dbInsertTrade(pos, exitPrice, pnl, roi, reason) {
  try {
    await sbFetch("/trades", "POST", {
      bot:        pos.bot,
      slug:       pos.slug,
      direction:  pos.direction,
      entry:      pos.entry,
      exit:       exitPrice,
      invested:   pos.invested,
      pnl,
      roi,
      reason,
      z_score:    pos.zScoreAtEntry || null,
      opened_at:  new Date(pos.opened).toISOString(),
      closed_at:  new Date().toISOString(),
    });
  } catch (err) {
    log(`dbInsertTrade error: ${err.message}`, "ERR");
  }
}

// ─── ESTADO EN MEMORIA ────────────────────────────────────────
let state = {
  cycle:           0,
  history:         {},
  positions:       [],
  closed:          [],
  equity:          { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY },
  peak:            { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY },
  dd:              { A: 0, B: 0, C: 0 },
  rejectedHistory: {},
  auditLog:        [],
};

// Carga estado desde Supabase al arrancar
async function loadState() {
  log("Cargando estado desde Supabase...");
  try {
    const [cycle, equity, peak, dd, history, positions, closed, rejHist, auditLog] =
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
      ]);

    if (cycle     !== null) state.cycle           = cycle;
    if (equity    !== null) state.equity          = equity;
    if (peak      !== null) state.peak            = peak;
    if (dd        !== null) state.dd              = dd;
    if (history   !== null) state.history         = history;
    if (positions !== null) state.positions       = positions;
    if (closed    !== null) state.closed          = closed;
    if (rejHist   !== null) state.rejectedHistory = rejHist;
    if (auditLog  !== null) state.auditLog        = auditLog;

    // ── Recalcular equity real desde tabla trades ──────────────
    // El equity en bot_state puede estar desactualizado si el bot
    // se reinició justo tras un trade. Reconstruimos desde la fuente
    // de verdad: la tabla trades de Supabase.
    try {
      const allTrades = await sbFetch("/trades?select=bot,invested,pnl");
      if (allTrades && allTrades.length > 0) {
        // Partir de equity inicial
        const realEquity = { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY };
        // Restar lo invertido en posiciones abiertas actualmente
        for (const pos of state.positions) {
          realEquity[pos.bot] -= pos.invested;
        }
        // Sumar PnL neto de todos los trades cerrados
        for (const t of allTrades) {
          if (realEquity[t.bot] !== undefined) {
            realEquity[t.bot] += t.pnl;
          }
        }
        state.equity = realEquity;
        state.peak   = {
          A: Math.max(state.peak.A, realEquity.A),
          B: Math.max(state.peak.B, realEquity.B),
          C: Math.max(state.peak.C, realEquity.C),
        };
        log(`Equity recalculado desde ${allTrades.length} trades → A=$${realEquity.A.toFixed(2)} B=$${realEquity.B.toFixed(2)} C=$${realEquity.C.toFixed(2)}`);
      }
    } catch (eqErr) {
      log(`No se pudo recalcular equity: ${eqErr.message}`, "WARN");
    }

    log(`Estado cargado: ciclo=${state.cycle} trades_db=${state.closed.length} mercados_mem=${Object.keys(state.history).length}`);
  } catch (err) {
    log(`Error cargando estado, iniciando desde cero: ${err.message}`, "WARN");
  }
}

// Guarda estado en Supabase (operaciones en paralelo)
async function saveState() {
  try {
    await Promise.all([
      dbSet("cycle",           state.cycle),
      dbSet("equity",          state.equity),
      dbSet("peak",            state.peak),
      dbSet("dd",              state.dd),
      dbSet("history",         state.history),
      dbSet("positions",       state.positions),
      dbSet("closed",          state.closed),
      dbSet("rejectedHistory", state.rejectedHistory),
      dbSet("auditLog",        state.auditLog),
    ]);
  } catch (err) {
    log(`saveState error
$$
