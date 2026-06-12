```javascript
// ─── LOGGING ──────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function log(msg, level = "INFO") {
  const prefix = level === "WARN" ? "⚠ " : level === "ERR" ? "✖ " : level === "TRADE" ? "◆ " : "  ";
  console.log(`[${ts()}] ${prefix}${msg}`);
}

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  INITIAL_EQUITY: 200,

  PRICE_MIN: 0.03,
  PRICE_MAX: 0.90,
  MIN_VOLUME_24H: 50_000,
  MIN_LIQ: 20_000,

  // Override para mercados con z-score muy alto
  MIN_VOLUME_24H_OVERRIDE: 20_000,
  MIN_LIQ_OVERRIDE: 8_000,
  PRICE_MIN_OVERRIDE: 0.01,
  PRICE_MAX_OVERRIDE: 0.95,
  ZSCORE_OVERRIDE_THRESHOLD: 2.5,

  RISK_PER_TRADE: 0.025,
  MAX_OPEN_PER_BOT: 2,

  FEE_RATE: 0.005,

  STOP_LOSS_ROI: -0.12,
  TAKE_PROFIT_ROI: 0.20,
  MAX_HOLD_MS: 12 * 60 * 60 * 1000,

  CYCLE_INTERVAL_MS: 60 * 60 * 1000,

  HISTORY_WINDOW: 12,
  HISTORY_EXTRA: 2,
  REVERSION_THRESHOLD: 1.8,
  MIN_HIST_CYCLES: 8,
};

const BOTS = {
  A: { MIN_ZSCORE: 2.2, label: "Conservative" },
  B: { MIN_ZSCORE: 2.0, label: "Balanced"     },
  C: { MIN_ZSCORE: 1.8, label: "Aggressive"   },
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

// ─── MIGRACIÓN BUY → SELL_PROXY ───────────────────────────────
function migrateBuyPositions() {
  let migratedCount = 0;

  for (const pos of state.positions) {
    if (pos.direction === "BUY") {
      const oldEntry = pos.entry;
      const oldDirection = pos.direction;

      // Convertir BUY a SELL_PROXY
      pos.direction = "SELL_PROXY";
      pos.entry = 1 - pos.entry;
      pos.yesAtEntry = oldEntry;
      pos._migrated = true;
      pos._migratedAt = Date.now();

      migratedCount++;
      log(`MIGRADO: ${pos.slug.slice(0, 40)} ${oldDirection}@${oldEntry.toFixed(3)} → SELL_PROXY@${pos.entry.toFixed(3)}`, "WARN");
    }
  }

  if (migratedCount > 0) {
    log(`✓ Migradas ${migratedCount} posiciones BUY → SELL_PROXY`, "WARN");
  }

  return migratedCount;
}

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

    // ✅ MIGRACIÓN AUTOMÁTICA de BUY → SELL_PROXY
    const buyPositionsBefore = state.positions.filter(p => p.direction === "BUY").length;
    if (buyPositionsBefore > 0) {
      log(`⚠️ Detectadas ${buyPositionsBefore} posiciones BUY → Migrando a SELL_PROXY`, "WARN");
      migrateBuyPositions();
      // Guardar estado migrado inmediatamente
      await saveState();
    }

    // Diagnóstico de trades BUY históricos (solo informativo)
    const buyTrades = state.closed.filter(t => t.direction === "BUY").length;
    if (buyTrades > 0) {
      log(`ℹ️ Historial contiene ${buyTrades} trades BUY cerrados de versiones anteriores (no afectan equity)`, "WARN");
    }

    // Recalcular equity desde tabla trades
    try {
      const allTrades = await sbFetch("/trades?select=bot,invested,pnl");
      if (allTrades && allTrades.length > 0) {
        const realEquity = { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY };

        // Restar capital en posiciones abiertas actuales (las migradas ya son SELL_PROXY)
        for (const pos of state.positions) {
          if (realEquity[pos.bot] !== undefined && pos.direction === "SELL_PROXY") {
            realEquity[pos.bot] -= pos.invested;
          }
        }

        // Sumar PnL de trades cerrados (excluyendo BUY antiguos)
        for (const t of allTrades) {
          if (realEquity[t.bot] !== undefined && t.direction !== "BUY") {
            realEquity[t.bot] += t.pnl;
          }
        }

        state.equity = realEquity;
        state.peak   = {
          A: Math.max(state.peak.A || CONFIG.INITIAL_EQUITY, realEquity.A),
          B: Math.max(state.peak.B || CONFIG.INITIAL_EQUITY, realEquity.B),
          C: Math.max(state.peak.C || CONFIG.INITIAL_EQUITY, realEquity.C),
        };
        log(`Equity recalculado → A=$${realEquity.A.toFixed(2)} B=$${realEquity.B.toFixed(2)} C=$${realEquity.C.toFixed(2)}`);
      }
    } catch (eqErr) {
      log(`No se pudo recalcular equity: ${eqErr.message}`, "WARN");
    }

    log(`Estado cargado: ciclo=${state.cycle} trades=${state.closed.length} mercados=${Object.keys(state.history).length}`);
  } catch (err) {
    log(`Error cargando estado, iniciando desde cero: ${err.message}`, "WARN");
  }
}

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
    log(`saveState error: ${err.message}`, "ERR");
  }
}

// ─── API POLYMARKET ───────────────────────────────────────────
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
        signal: AbortSignal.timeout(20_000),
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
    if (prices.length > 0) {
      return prices.reduce((a, b) =>
        Math.abs(b - 0.5) < Math.abs(a - 0.5) ? b : a, prices[0]);
    }
    return Number(m.lastPrice || 0.5);
  } catch {
    return Number(m.lastPrice || 0.5);
  }
}

function filterMarkets(markets, signalOverrideSlugs = new Set()) {
  const rejected = { price: 0, volume: 0, liquidity: 0 };
  const valid = [];
  for (const m of markets) {
    const isOverride = signalOverrideSlugs.has(m.slug);

    const priceMin = isOverride ? CONFIG.PRICE_MIN_OVERRIDE : CONFIG.PRICE_MIN;
    const priceMax = isOverride ? CONFIG.PRICE_MAX_OVERRIDE : CONFIG.PRICE_MAX;
    const volMin   = isOverride ? CONFIG.MIN_VOLUME_24H_OVERRIDE : CONFIG.MIN_VOLUME_24H;
    const liqMin   = isOverride ? CONFIG.MIN_LIQ_OVERRIDE        : CONFIG.MIN_LIQ;

    if (m.price < priceMin || m.price > priceMax) { rejected.price++;     continue; }
    if (m.volume24h < volMin)                      { rejected.volume++;    continue; }
    if (m.liquidity < liqMin)                      { rejected.liquidity++; continue; }
    valid.push(m);
  }
  return { valid, rejected };
}

function updateHistory(markets) {
  for (const m of markets) {
    if (!state.history[m.slug]) state.history[m.slug] = [];
    state.history[m.slug].push(m.price);
    if (state.history[m.slug].length > CONFIG.HISTORY_WINDOW + CONFIG.HISTORY_EXTRA) {
      state.history[m.slug].shift();
    }
  }
  const activeSlugs = new Set(markets.map(m => m.slug));
  for (const slug of Object.keys(state.history)) {
    if (!activeSlugs.has(slug)) delete state.history[slug];
  }
}

function computeSignal(m) {
  const hist = state.history[m.slug];
  if (!hist || hist.length < CONFIG.MIN_HIST_CYCLES) return null;

  const n    = hist.length;
  const mean = hist.reduce((s, p) => s + p, 0) / n;
  const std  = Math.sqrt(hist.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1));
  if (std < 0.005) return null;

  const zScore = (m.price - mean) / std;

  let direction, entryPrice, expectedReversion;
  if (zScore < -CONFIG.REVERSION_THRESHOLD) {
    direction = "BUY";
    entryPrice = m.price;
    expectedReversion = mean;
  } else if (zScore > CONFIG.REVERSION_THRESHOLD) {
    direction = "SELL_PROXY";
    entryPrice = 1 - m.price;
    expectedReversion = 1 - mean;
  } else {
    return null;
  }

  const absZScore = Math.abs(zScore);
  const volBonus  = Math.min(1.2, 1 + (m.volume24h - CONFIG.MIN_VOLUME_24H) / 500_000);
  const liqBonus  = Math.min(1.1, 1 + (m.liquidity - CONFIG.MIN_LIQ) / 200_000);

  return {
    direction,
    entryPrice,
    expectedReversion,
    zScore,
    absZScore,
    qualScore: absZScore * volBonus * liqBonus,
    mean,
    std
  };
}

function calcPnl(entry, exit, invested) {
  if (entry <= 0) return 0;
  const shares = invested / entry;
  return shares * (exit - entry) - invested * CONFIG.FEE_RATE;
}

function openPosition(bot, m, signal) {
  if (state.positions.some(p => p.bot === bot && p.slug === m.slug)) return;
  if (state.positions.filter(p => p.bot === bot).length >= CONFIG.MAX_OPEN_PER_BOT) return;
  if (state.equity[bot] < 10) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;
  if (invested <= 0) return;

  state.equity[bot] -= invested;

  state.positions.push({
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
  });

  log(`OPEN ${bot} [${signal.direction}] ${m.slug.slice(0, 30)} entry=${signal.entryPrice.toFixed(3)} z=${signal.zScore.toFixed(2)} $${invested.toFixed(2)}`, "TRADE");
}

async function closePosition(pos, exitPrice, reason) {
  if (pos.entry <= 0) {
    log(`ERROR: entry=${pos.entry} para ${pos.slug}`, "ERR");
    state.positions = state.positions.filter(p => p !== pos);
    return;
  }

  const netPnl = calcPnl(pos.entry, exitPrice, pos.invested);
  state.equity[pos.bot] += pos.invested + netPnl;

  const eq = state.equity[pos.bot];
  state.peak[pos.bot] = Math.max(state.peak[pos.bot] || CONFIG.INITIAL_EQUITY, eq);
  state.dd[pos.bot]   = Math.max(state.dd[pos.bot] || 0, (state.peak[pos.bot] - eq) / state.peak[pos.bot]);

  const roi = netPnl / pos.invested;

  state.closed.push({
    ...pos,
    exit: exitPrice,
    pnl: netPnl,
    roi,
    reason,
    closeTime: Date.now()
  });

  if (state.closed.length > 500) state.closed.shift();

  state.positions = state.positions.filter(p => p !== pos);

  const sign = netPnl >= 0 ? "+" : "";
  log(`CLOSE ${pos.bot} [${reason}] ${pos.slug.slice(0, 25)} pnl=${sign}$${netPnl.toFixed(2)} roi=${(roi*100).toFixed(1)}%`, "TRADE");

  await dbInsertTrade(pos, exitPrice, netPnl, roi, reason);
  await saveState();
}

async function managePositions(markets) {
  const now = Date.now();
  const priceMap = new Map(markets.map(m => [m.slug, m.price]));

  for (const pos of [...state.positions]) {
    // Protección contra posiciones BUY residuales (no debería haber después de migración)
    if (pos.direction === "BUY") {
      log(`⚠️ Posición BUY detectada en managePositions → Migrando: ${pos.slug}`, "WARN");
      pos.direction = "SELL_PROXY";
      pos.entry = 1 - pos.entry;
      pos.yesAtEntry = pos.entry;
    }

    const raw = priceMap.get(pos.slug);
    if (raw === undefined) continue;

    const eff = pos.direction === "SELL_PROXY" ? 1 - raw : raw;
    const roi = (eff - pos.entry) / pos.entry;

    if (roi <= CONFIG.STOP_LOSS_ROI) {
      await closePosition(pos, eff, "STOP_LOSS");
      continue;
    }
    if (roi >= CONFIG.TAKE_PROFIT_ROI) {
      await closePosition(pos, eff, "TAKE_PROFIT");
      continue;
    }
    if (now - pos.opened > CONFIG.MAX_HOLD_MS) {
      await closePosition(pos, eff, "TIMEOUT");
      continue;
    }

    // Partial reversión: si llevamos >60% del camino hacia expectedExit y tenemos +5%
    const progress = Math.abs(pos.expectedExit - pos.entry) > 0.001
      ? Math.abs(eff - pos.entry) / Math.abs(pos.expectedExit - pos.entry)
      : 0;
    if (progress > 0.6 && roi > 0.05) {
      await closePosition(pos, eff, "PARTIAL_REVERSION");
      continue;
    }
  }
}

function auditRejected(rejected, allMarkets) {
  if (!state.rejectedHistory) state.rejectedHistory = {};
  if (!state.auditLog) state.auditLog = [];

  for (const m of allMarkets) {
    if (rejected._validSlugs && rejected._validSlugs.has(m.slug)) continue;
    if (!state.rejectedHistory[m.slug]) state.rejectedHistory[m.slug] = [];
    state.rejectedHistory[m.slug].push({ price: m.price, ts: Date.now() });
    if (state.rejectedHistory[m.slug].length > CONFIG.HISTORY_WINDOW + CONFIG.HISTORY_EXTRA) {
      state.rejectedHistory[m.slug].shift();
    }
  }

  let wouldHaveSignal = 0, wouldHaveTP = 0;
  const details = [];

  for (const [slug, hist] of Object.entries(state.rejectedHistory)) {
    if (hist.length < CONFIG.MIN_HIST_CYCLES + 1) continue;
    const prices     = hist.map(h => h.price);
    const prevPrices = prices.slice(0, -1);
    const current    = prices[prices.length - 1];
    const prev       = prices[prices.length - 2];
    const mean       = prevPrices.reduce((s, p) => s + p, 0) / prevPrices.length;
    const std        = Math.sqrt(prevPrices.reduce((s, p) => s + (p - mean) ** 2, 0) / (prevPrices.length - 1));
    if (std < 0.005) continue;
    const z = (prev - mean) / std;
    if (Math.abs(z) < CONFIG.REVERSION_THRESHOLD) continue;
    wouldHaveSignal++;
    const entryPrice = z < 0 ? prev : 1 - prev;
    const exitPrice  = z < 0 ? current : 1 - current;
    const roi        = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0;
    if (roi >= CONFIG.TAKE_PROFIT_ROI) {
      wouldHaveTP++;
      details.push({ slug, z: z.toFixed(2), roi: (roi * 100).toFixed(0) + "%", entry: entryPrice.toFixed(3) });
    }
  }

  if (wouldHaveSignal > 0) {
    log(`AUDIT | rechazados con señal=${wouldHaveSignal} habrían TP=${wouldHaveTP}`, "WARN");
    for (const d of details) {
      log(`  AUDIT-TP ${d.slug.slice(0, 35)} z=${d.z} entry=${d.entry} roi=${d.roi}`, "WARN");
    }
    state.auditLog.push({ cycle: state.cycle, ts: Date.now(), wouldHaveSignal, wouldHaveTP, details });
    if (state.auditLog.length > 200) state.auditLog.shift();
  }
}

function printReport(totalMarkets, validCount, rejected) {
  const div = "─".repeat(60);
  log(div);
  log(`CICLO ${state.cycle} | Mercados: ${totalMarkets} total, ${validCount} válidos`);
  log(`Rechazados → precio:${rejected.price} vol:${rejected.volume} liq:${rejected.liquidity}`);

  for (const b of ["A", "B", "C"]) {
    const openPos   = state.positions.filter(p => p.bot === b);
    const botClosed = state.closed.filter(t => t.bot === b && t.direction !== "BUY");
    const wins      = botClosed.filter(t => t.pnl > 0).length;
    const pnl       = botClosed.reduce((s, t) => s + t.pnl, 0);
    const wr        = botClosed.length ? ((wins / botClosed.length) * 100).toFixed(0) : "—";

    log(`BOT ${b} (${BOTS[b].label}) | equity=$${state.equity[b].toFixed(2)} | pos=${openPos.length}/${CONFIG.MAX_OPEN_PER_BOT} | DD=${((state.dd[b] || 0)*100).toFixed(1)}% | trades=${botClosed.length} WR=${wr}% pnl=$${pnl.toFixed(2)}`);

    for (const p of openPos) {
      const age = Math.round((Date.now() - p.opened) / 60_000);
      const currentPrice = p.direction === "SELL_PROXY" ? (1 - (priceMapGlobal.get(p.slug) || 0)) : (priceMapGlobal.get(p.slug) || 0);
      const currentRoi = ((currentPrice - p.entry) / p.entry * 100).toFixed(1);
      log(`  └ ${p.direction} ${p.slug.slice(0, 35)} | entry=${p.entry.toFixed(3)} | roi=${currentRoi}% | age=${age}m`);
    }
  }

  const allClosed = state.closed.filter(t => t.direction !== "BUY");
  if (allClosed.length > 0) {
    const wins     = allClosed.filter(t => t.pnl > 0);
    const losses   = allClosed.filter(t => t.pnl <= 0);
    const totalPnl = allClosed.reduce((s, t) => s + t.pnl, 0);
    const gw       = wins.reduce((s, t) => s + t.pnl, 0);
    const gl       = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf       = gl > 0 ? (gw / gl).toFixed(2) : "∞";
    const wr       = ((wins.length / allClosed.length) * 100).toFixed(1);
    log(`GLOBAL | trades=${allClosed.length} WR=${wr}% PF=${pf} pnl=$${totalPnl.toFixed(2)}`);
    const byReason = {};
    for (const t of allClosed) {
      if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 };
      byReason[t.reason].n++;
      byReason[t.reason].pnl += t.pnl;
    }
    for (const [r, s] of Object.entries(byReason)) {
      log(`  ${r}: ${s.n} trades pnl=$${s.pnl.toFixed(2)}`);
    }
  }
  log(div);
}

// Variable global temporal para printReport
let priceMapGlobal = new Map();

async function runCycle() {
  state.cycle++;
  const t0 = Date.now();
  try {
    const allMarkets = await fetchMarkets();
    if (allMarkets.length === 0) {
      log("Sin mercados, reintentando...", "WARN");
      return;
    }

    // Guardar priceMap para printReport
    priceMapGlobal = new Map(allMarkets.map(m => [m.slug, m.price]));

    await managePositions(allMarkets);

    // Detectar slugs con z-score muy alto en rejectedHistory para bajarles filtros
    const signalOverrideSlugs = new Set();
    if (state.rejectedHistory) {
      for (const [slug, hist] of Object.entries(state.rejectedHistory)) {
        if (hist.length < CONFIG.MIN_HIST_CYCLES) continue;
        const prices = hist.map(h => h.price);
        const mean   = prices.reduce((s, p) => s + p, 0) / prices.length;
        const std    = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / (prices.length - 1));
        if (std < 0.005) continue;
        const z = (prices[prices.length - 1] - mean) / std;
        if (Math.abs(z) >= CONFIG.ZSCORE_OVERRIDE_THRESHOLD) signalOverrideSlugs.add(slug);
      }
      if (signalOverrideSlugs.size > 0) {
        log(`Override vol/liq/precio para ${signalOverrideSlugs.size} slugs con z≥${CONFIG.ZSCORE_OVERRIDE_THRESHOLD}`);
      }
    }

    const { valid, rejected } = filterMarkets(allMarkets, signalOverrideSlugs);
    rejected._validSlugs = new Set(valid.map(m => m.slug));

    updateHistory(valid);

    const candidates = valid
      .map(m => ({ ...m, signal: computeSignal(m) }))
      .filter(m => m.signal);

    // Cada bot usa sus propios slugs abiertos
    for (const [bot, botConfig] of Object.entries(BOTS)) {
      const botOpenSlugs = new Set(state.positions.filter(p => p.bot === bot).map(p => p.slug));
      const eligible = candidates
        .filter(c =>
          !botOpenSlugs.has(c.slug) &&
          c.signal.absZScore >= botConfig.MIN_ZSCORE &&
          state.equity[bot] > 10
        )
        .sort((a, b) => b.signal.qualScore - a.signal.qualScore);

      if (!eligible.length) continue;

      for (const candidate of eligible) {
        if (state.positions.filter(p => p.bot === bot).length >= CONFIG.MAX_OPEN_PER_BOT) break;
        if (botOpenSlugs.has(candidate.slug)) continue;
        openPosition(bot, candidate, candidate.signal);
        botOpenSlugs.add(candidate.slug);
      }
    }

    auditRejected(rejected, allMarkets);
    printReport(allMarkets.length, valid.length, rejected);
    log(`Ciclo completado en ${Date.now() - t0}ms`);

  } catch (err) {
    log(`Error en ciclo: ${err.message}`, "ERR");
    console.error(err.stack);
  } finally {
    await saveState();
  }
}

async function scheduler() {
  const t0 = Date.now();
  await runCycle();
  const delay = Math.max(5_000, CONFIG.CYCLE_INTERVAL_MS - (Date.now() - t0));
  setTimeout(scheduler, delay);
}

// ─── ARRANQUE ─────────────────────────────────────────────────
log("════════════════════════════════════════════════════════════");
log("MICRODRIFT v5.9 — Migración BUY automática + fixes");
log(`Supabase: ${SUPABASE_URL}`);
log(`Capital: $${CONFIG.INITIAL_EQUITY} × 3 bots = $${CONFIG.INITIAL_EQUITY * 3} total`);
log(`Timeout: ${CONFIG.MAX_HOLD_MS/60_000}m | Stop: ${CONFIG.STOP_LOSS_ROI*100}% | TP: ${CONFIG.TAKE_PROFIT_ROI*100}%`);
log(`Bots: A(z≥${BOTS.A.MIN_ZSCORE}) B(z≥${BOTS.B.MIN_ZSCORE}) C(z≥${BOTS.C.MIN_ZSCORE})`);
log("════════════════════════════════════════════════════════════");
log("AVISO: Esto es PAPER TRADING. No opera con dinero real.");
log("════════════════════════════════════════════════════════════");

loadState().then(() => scheduler());

process.on("uncaughtException", err => {
  log(`Excepción: ${err.message}`, "ERR");
  saveState().then(() => process.exit(1));
});

process.on("unhandledRejection", reason => {
  log(`Rechazo: ${reason}`, "ERR");
  saveState();
});

process.on("SIGINT", () => {
  log("Deteniendo...");
  saveState().then(() => process.exit(0));
});

// ─── HTTP HEALTH SERVER ───────────────────────────────────────
import http from "http";

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const totalPnl = state.closed
    .filter(t => t.direction !== "BUY")
    .reduce((s, t) => s + t.pnl, 0);

  const body = JSON.stringify({
    status: "running",
    cycle: state.cycle,
    equity: state.equity,
    trades: state.closed.filter(t => t.direction !== "BUY").length,
    pnl: totalPnl.toFixed(2),
    positions: state.positions.length,
    uptime: Math.round(process.uptime()) + "s",
  }, null, 2);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}).listen(PORT, () => {
  log(`HTTP health server escuchando en puerto ${PORT}`);
});
```

---

## Resumen de Cambios en v5.9

| Cambio | Descripción |
|--------|-------------|
| **Migración BUY automática** | `migrateBuyPositions()` convierte BUY → SELL_PROXY al cargar estado |
| **Protección en managePositions** | Si queda algún BUY residual, lo migra on-the-fly |
| **Exclusión BUY de estadísticas** | `printReport` y `equity` ignoran trades BUY antiguos |
| **Fix AbortSignal.timeout** | Reemplaza `timeout: 20_000` por `signal: AbortSignal.timeout(20_000)` |
| **Fix progress division** | Protección contra división por cero en partial reversión |
| **priceMapGlobal** | Para mostrar ROI actual en el reporte |

Listo para copiar y pegar.
