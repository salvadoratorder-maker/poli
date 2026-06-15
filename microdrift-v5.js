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

  PRICE_MIN: 0.03,
  PRICE_MAX: 0.90,
  MIN_VOLUME_24H: 20_000,
  MIN_LIQ: 10_000,

  MIN_VOLUME_24H_OVERRIDE: 8_000,
  MIN_LIQ_OVERRIDE: 3_000,
  PRICE_MIN_OVERRIDE: 0.01,
  PRICE_MAX_OVERRIDE: 0.95,
  ZSCORE_OVERRIDE_THRESHOLD: 2.5,

  RISK_PER_TRADE: 0.025,
  MAX_OPEN_PER_BOT: 3,

  FEE_RATE: 0.005,

  STOP_LOSS_ROI:   -0.12,
  TAKE_PROFIT_ROI:  0.20,
  MAX_HOLD_MS: 24 * 60 * 60 * 1000,   // v6.3: era 12h

  HISTORY_WINDOW:   24,                // v6.3: era 12
  HISTORY_EXTRA:     2,
  REVERSION_THRESHOLD: 1.5,
  MIN_HIST_CYCLES:   8,                // v6.3: era 4

  CYCLE_INTERVAL_MS: 60 * 60 * 1000,

  TRAILING_STOP_TRIGGER_ROI: 0.10,    // v6.3

  // Diversificación espacial (v6.2)
  MAX_CATEGORY_POSITIONS: { sports: 2, politics: 2, macro: 2, other: 3 },
  MAX_POSITIONS_PER_KEY: 1,

  // ─── ADAPTIVE COOLDOWN (v6.4) ─────────────────────────────
  // Ciclos de espera mínimos antes de re-entrar en una key,
  // diferenciados por razón de cierre.
  //
  // Lógica:
  //   TAKE_PROFIT → el mercado llegó a la media, puede rebotar.
  //                 Esperar más antes de re-entrar.
  //   STOP_LOSS   → movimiento en contra. Cooldown corto para
  //                 no perder reversión posterior.
  //   TIMEOUT     → el precio no se movió. Cooldown mínimo.
  //   (resto)     → 2 ciclos por defecto conservador.
  //
  // Con CYCLE_INTERVAL_MS = 1h:
  //   TAKE_PROFIT  = 8h de espera
  //   STOP_LOSS    = 3h
  //   TIMEOUT      = 1h
  COOLDOWN_BY_REASON: {
    TAKE_PROFIT:       8,
    PARTIAL_REVERSION: 8,
    TRAILING_STOP:     6,
    STOP_LOSS:         3,
    TIMEOUT:           1,
    MIGRATION_CLOSE:   1,
    DEFAULT:           2,
  },

  // Límite adicional: máximo de trades por key en 24h (= 24 ciclos)
  MAX_TRADES_PER_KEY_24H: 2,

  // Alerta si la utilización de capital cae por debajo de este umbral
  CAPITAL_UTILIZATION_WARN: 0.20,
};

const BOTS = {
  A: { MIN_ZSCORE: 2.0, label: "Conservative" },
  B: { MIN_ZSCORE: 1.8, label: "Balanced"     },
  C: { MIN_ZSCORE: 1.5, label: "Aggressive"   },
};

// ─── CATEGORIZACIÓN DE MERCADOS ───────────────────────────────
const SPORT_KEYS = [
  "knicks", "spurs", "celtics", "lakers", "warriors", "heat", "nuggets",
  "bucks", "sixers", "suns", "clippers", "nets", "bulls", "pistons",
  "yankees", "dodgers", "red sox", "cubs", "astros", "mets", "giants",
  "chiefs", "eagles", "patriots", "cowboys", "49ers", "ravens", "packers",
  "england", "france", "brazil", "argentina", "germany", "spain", "portugal",
  "djokovic", "alcaraz", "sinner", "nadal", "federer", "swiatek",
  "verstappen", "hamilton", "leclerc", "norris", "russell",
  "pogacar", "vingegaard", "evenepoel",
];

function marketCategory(question) {
  const q = question.toLowerCase();
  if (/nba|mlb|nfl|nhl|fifa|soccer|tennis|f1|formula 1|ufc|world cup|champions league|la liga|premier league|tour de france|wimbledon|roland garros/.test(q)) return "sports";
  if (/election|president|senate|congress|prime minister|vote|referendum|ballot|governor|mayor|nomination/.test(q)) return "politics";
  if (/fed|federal reserve|interest rate|inflation|gdp|recession|powell|cpi|unemployment|fomc/.test(q)) return "macro";
  return "other";
}

function marketKey(question, slug = "") {
  const q = question.toLowerCase();
  for (const key of SPORT_KEYS) {
    if (q.includes(key)) return key;
  }
  return slug;
}

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
      mae:        pos.mae ?? null,
      mfe:        pos.mfe ?? null,
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
  // v6.4: memoria temporal de cierres por key
  // { [key]: { cycle, reason, roi } }
  keyCooldown:     {},
};

async function loadState() {
  log("Cargando estado desde Supabase...");
  try {
    const [cycle, equity, peak, dd, history, positions, closed,
           rejHist, auditLog, keyCooldown] =
      await Promise.all([
        dbGet("cycle"),    dbGet("equity"),   dbGet("peak"),
        dbGet("dd"),       dbGet("history"),  dbGet("positions"),
        dbGet("closed"),   dbGet("rejectedHistory"), dbGet("auditLog"),
        dbGet("keyCooldown"),   // v6.4
      ]);

    if (cycle        !== null) state.cycle           = cycle;
    if (equity       !== null) state.equity          = equity;
    if (peak         !== null) state.peak            = peak;
    if (dd           !== null) state.dd              = dd;
    if (history      !== null) state.history         = history;
    if (positions    !== null) state.positions       = positions;
    if (closed       !== null) state.closed          = closed;
    if (rejHist      !== null) state.rejectedHistory = rejHist;
    if (auditLog     !== null) state.auditLog        = auditLog;
    if (keyCooldown  !== null) state.keyCooldown     = keyCooldown;

    const buyOpen = state.positions.filter(p => p.direction === "BUY").length;
    if (buyOpen > 0) log(`⚠️ ATENCIÓN: quedan ${buyOpen} BUY abiertos`, "WARN");
    else             log("✓ posiciones verificadas", "INFO");

    try {
      const allTrades = await sbFetch("/trades?select=bot,invested,pnl");
      if (allTrades && allTrades.length > 0) {
        const realEquity = { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY, C: CONFIG.INITIAL_EQUITY };
        for (const pos of state.positions) {
          if (realEquity[pos.bot] !== undefined) realEquity[pos.bot] -= pos.invested;
        }
        for (const t of allTrades) {
          if (realEquity[t.bot] !== undefined) realEquity[t.bot] += t.pnl;
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

    log(`Estado cargado: ciclo=${state.cycle} trades=${state.closed.length} cooldowns=${Object.keys(state.keyCooldown).length}`);
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
      dbSet("keyCooldown",     state.keyCooldown),   // v6.4
    ]);
  } catch (err) {
    log(`saveState error: ${err.message}`, "ERR");
  }
}

// ─── API POLYMARKET ───────────────────────────────────────────
async function fetchMarkets() {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(
      `${CONFIG.API}/markets?active=true&closed=false&limit=150`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept":          "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Origin":          "https://polymarket.com",
          "Referer":         "https://polymarket.com/",
        },
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
        liquidity: Number(m.liquidity  || 0),
      }))
      .filter(m => m.price > 0.005 && m.price < 0.995);
  } catch (err) {
    log(`fetchMarkets: ${err.name === "AbortError" ? "timeout (20s)" : err.message}`, "ERR");
    return [];
  } finally {
    clearTimeout(timeoutId);
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
  const valid    = [];
  for (const m of markets) {
    const isOverride = signalOverrideSlugs.has(m.slug);
    const priceMin   = isOverride ? CONFIG.PRICE_MIN_OVERRIDE : CONFIG.PRICE_MIN;
    const priceMax   = isOverride ? CONFIG.PRICE_MAX_OVERRIDE : CONFIG.PRICE_MAX;
    const volMin     = isOverride ? CONFIG.MIN_VOLUME_24H_OVERRIDE : CONFIG.MIN_VOLUME_24H;
    const liqMin     = isOverride ? CONFIG.MIN_LIQ_OVERRIDE        : CONFIG.MIN_LIQ;

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
    direction = "BUY";        entryPrice = m.price;     expectedReversion = mean;
  } else if (zScore > CONFIG.REVERSION_THRESHOLD) {
    direction = "SELL_PROXY"; entryPrice = 1 - m.price; expectedReversion = 1 - mean;
  } else {
    return null;
  }

  const absZScore = Math.abs(zScore);
  const volBonus  = Math.min(1.2, 1 + (m.volume24h - CONFIG.MIN_VOLUME_24H) / 500_000);
  const liqBonus  = Math.min(1.1, 1 + (m.liquidity  - CONFIG.MIN_LIQ)        / 200_000);

  return { direction, entryPrice, expectedReversion, zScore, absZScore, qualScore: absZScore * volBonus * liqBonus, mean, std };
}

function calcPnl(entry, exit, invested) {
  const shares = invested / entry;
  return shares * (exit - entry) - invested * CONFIG.FEE_RATE;
}

// ─── HELPERS COOLDOWN ─────────────────────────────────────────

// Devuelve los ciclos de cooldown según la razón de cierre.
function cooldownCycles(reason) {
  return CONFIG.COOLDOWN_BY_REASON[reason] ?? CONFIG.COOLDOWN_BY_REASON.DEFAULT;
}

// Devuelve true si la key está en cooldown en el ciclo actual.
function isKeyCoolingDown(key) {
  const entry = state.keyCooldown[key];
  if (!entry) return false;
  const required = cooldownCycles(entry.reason);
  return (state.cycle - entry.cycle) < required;
}

// Devuelve cuántos trades se han abierto sobre esta key en las últimas 24h.
function tradesLast24h(key) {
  const cutoff = state.cycle - 24;
  return state.closed.filter(t => {
    const k = t.marketKey || marketKey(t.question || "", t.slug || "");
    return k === key && (t.cycleOpened || 0) >= cutoff;
  }).length;
}

function openPosition(bot, m, signal) {
  if (state.positions.some(p => p.bot === bot && p.slug === m.slug)) return;
  if (state.positions.filter(p => p.bot === bot).length >= CONFIG.MAX_OPEN_PER_BOT) return;
  if (state.equity[bot] < 10) return;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;
  state.equity[bot] -= invested;

  const cat = marketCategory(m.question);
  const key = marketKey(m.question, m.slug);

  state.positions.push({
    bot, slug: m.slug, question: m.question,
    direction: signal.direction, entry: signal.entryPrice,
    expectedExit: signal.expectedReversion, zScoreAtEntry: signal.zScore,
    invested, shares: invested / signal.entryPrice,
    opened: Date.now(), cycleOpened: state.cycle,
    category: cat, marketKey: key,
    mae: 0, mfe: 0,
    trailingStopEntry: null,
  });

  log(`OPEN ${bot} [${signal.direction}] [${cat}/${key}] ${m.slug.slice(0, 28)} entry=${signal.entryPrice.toFixed(3)} z=${signal.zScore.toFixed(2)} $${invested.toFixed(2)}`, "TRADE");
}

async function closePosition(pos, exitPrice, reason) {
  const netPnl = calcPnl(pos.entry, exitPrice, pos.invested);
  state.equity[pos.bot] += pos.invested + netPnl;

  const eq = state.equity[pos.bot];
  state.peak[pos.bot] = Math.max(state.peak[pos.bot], eq);
  state.dd[pos.bot]   = Math.max(state.dd[pos.bot], (state.peak[pos.bot] - eq) / state.peak[pos.bot]);

  const roi = netPnl / pos.invested;

  state.closed.push({ ...pos, exit: exitPrice, pnl: netPnl, roi, reason, closeTime: Date.now() });
  if (state.closed.length > 500) state.closed.shift();

  state.positions = state.positions.filter(p => p !== pos);

  // v6.4: registrar cooldown con razón y ROI para adaptive cooldown
  const key = pos.marketKey || marketKey(pos.question, pos.slug);
  state.keyCooldown[key] = { cycle: state.cycle, reason, roi };

  // Limpieza de entradas de cooldown caducadas (>50 ciclos)
  for (const [k, entry] of Object.entries(state.keyCooldown)) {
    if (state.cycle - entry.cycle > 50) delete state.keyCooldown[k];
  }

  const sign    = netPnl > 0 ? "+" : "";
  const maeStr  = pos.mae != null ? ` mae=${(pos.mae*100).toFixed(1)}%` : "";
  const mfeStr  = pos.mfe != null ? ` mfe=${(pos.mfe*100).toFixed(1)}%` : "";
  const cd      = cooldownCycles(reason);
  log(`CLOSE ${pos.bot} [${reason}] [cd=${cd}c] ${pos.slug.slice(0, 22)} pnl=${sign}$${netPnl.toFixed(2)} roi=${(roi*100).toFixed(1)}%${maeStr}${mfeStr}`, "TRADE");

  await dbInsertTrade(pos, exitPrice, netPnl, roi, reason);
  await saveState();
}

async function managePositions(markets) {
  const now      = Date.now();
  const priceMap = new Map(markets.map(m => [m.slug, m.price]));

  for (const pos of [...state.positions]) {
    const raw = priceMap.get(pos.slug);
    if (raw === undefined) continue;

    const eff = pos.direction === "SELL_PROXY" ? 1 - raw : raw;
    const roi = (eff - pos.entry) / pos.entry;

    if (pos.mae == null || roi < pos.mae) pos.mae = roi;
    if (pos.mfe == null || roi > pos.mfe) pos.mfe = roi;

    // Trailing stop
    if (roi >= CONFIG.TRAILING_STOP_TRIGGER_ROI && pos.trailingStopEntry === null) {
      pos.trailingStopEntry = pos.entry;
      log(`TRAILING STOP activado ${pos.bot} ${pos.slug.slice(0, 25)} @ roi=${(roi*100).toFixed(1)}%`, "WARN");
    }
    if (pos.trailingStopEntry !== null && eff <= pos.trailingStopEntry) {
      await closePosition(pos, eff, "TRAILING_STOP");
      continue;
    }

    if (roi <= CONFIG.STOP_LOSS_ROI)           { await closePosition(pos, eff, "STOP_LOSS");         continue; }
    if (roi >= CONFIG.TAKE_PROFIT_ROI)         { await closePosition(pos, eff, "TAKE_PROFIT");       continue; }
    if (now - pos.opened > CONFIG.MAX_HOLD_MS) { await closePosition(pos, eff, "TIMEOUT");           continue; }

    const progress = Math.abs(eff - pos.entry) / Math.abs(pos.expectedExit - pos.entry);
    if (progress > 0.6 && roi > 0.05)         { await closePosition(pos, eff, "PARTIAL_REVERSION"); continue; }
  }
}

function auditRejected(rejected, allMarkets, validSlugs) {
  if (!state.rejectedHistory) state.rejectedHistory = {};
  if (!state.auditLog)        state.auditLog = [];

  for (const m of allMarkets) {
    if (validSlugs.has(m.slug)) continue;
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
    const roi        = (exitPrice - entryPrice) / entryPrice;
    if (roi >= CONFIG.TAKE_PROFIT_ROI) {
      wouldHaveTP++;
      details.push({ slug, z: z.toFixed(2), roi: (roi * 100).toFixed(0) + "%", entry: entryPrice.toFixed(3) });
    }
  }

  if (wouldHaveSignal > 0) {
    log(`AUDIT | rechazados con señal=${wouldHaveSignal} habrían TP=${wouldHaveTP}`, "WARN");
    for (const d of details) log(`  AUDIT-TP ${d.slug.slice(0, 35)} z=${d.z} entry=${d.entry} roi=${d.roi}`, "WARN");
    state.auditLog.push({ cycle: state.cycle, ts: Date.now(), wouldHaveSignal, wouldHaveTP, details });
    if (state.auditLog.length > 200) state.auditLog.shift();
  }
}

function printReport(totalMarkets, validCount, rejected, candidateCount) {
  const div = "─".repeat(60);
  log(div);
  log(`CICLO ${state.cycle} | Mercados: ${totalMarkets} total, ${validCount} válidos`);
  log(`Rechazados → precio:${rejected.price} vol:${rejected.volume} liq:${rejected.liquidity}`);
  log(`Candidatos con señal: ${candidateCount} | En cooldown: ${Object.keys(state.keyCooldown).filter(k => isKeyCoolingDown(k)).length}`);

  // Utilización de capital (v6.4)
  const totalEquity    = Object.values(state.equity).reduce((s, e) => s + e, 0);
  const totalInvested  = state.positions.reduce((s, p) => s + p.invested, 0);
  const utilization    = totalEquity > 0 ? totalInvested / (totalInvested + totalEquity) : 0;
  if (utilization < CONFIG.CAPITAL_UTILIZATION_WARN && state.cycle > 10) {
    log(`⚠ CAPITAL_UTILIZATION bajo: ${(utilization*100).toFixed(1)}% (umbral: ${CONFIG.CAPITAL_UTILIZATION_WARN*100}%)`, "WARN");
  } else {
    log(`Capital utilización: ${(utilization*100).toFixed(1)}%`);
  }

  for (const b of ["A", "B", "C"]) {
    const openPos   = state.positions.filter(p => p.bot === b);
    const botClosed = state.closed.filter(t => t.bot === b);
    const wins      = botClosed.filter(t => t.pnl > 0).length;
    const pnl       = botClosed.reduce((s, t) => s + t.pnl, 0);
    const wr        = botClosed.length ? ((wins / botClosed.length) * 100).toFixed(0) : "—";
    log(`BOT ${b} (${BOTS[b].label}) | equity=$${state.equity[b].toFixed(2)} | pos=${openPos.length}/${CONFIG.MAX_OPEN_PER_BOT} | DD=${(state.dd[b]*100).toFixed(1)}% | trades=${botClosed.length} WR=${wr}% pnl=$${pnl.toFixed(2)}`);

    const openByCategory = {};
    for (const p of openPos) {
      const cat = p.category || marketCategory(p.question);
      openByCategory[cat] = (openByCategory[cat] || 0) + 1;
    }
    log(
      `  Categorías: ` +
      `sports=${openByCategory.sports||0}/${CONFIG.MAX_CATEGORY_POSITIONS.sports} ` +
      `politics=${openByCategory.politics||0}/${CONFIG.MAX_CATEGORY_POSITIONS.politics} ` +
      `macro=${openByCategory.macro||0}/${CONFIG.MAX_CATEGORY_POSITIONS.macro} ` +
      `other=${openByCategory.other||0}/${CONFIG.MAX_CATEGORY_POSITIONS.other}`
    );

    for (const p of openPos) {
      const age    = Math.round((Date.now() - p.opened) / 60_000);
      const cat    = p.category  || marketCategory(p.question);
      const key    = p.marketKey || marketKey(p.question, p.slug);
      const tsFlag = p.trailingStopEntry !== null ? " [TS✓]" : "";
      const maeStr = p.mae != null ? ` mae=${(p.mae*100).toFixed(1)}%` : "";
      const mfeStr = p.mfe != null ? ` mfe=${(p.mfe*100).toFixed(1)}%` : "";
      log(`  └ ${p.direction} [${cat}/${key}]${tsFlag} ${p.slug.slice(0, 28)} | entry=${p.entry.toFixed(3)} | age=${age}m${maeStr}${mfeStr}`);
    }
  }

  // Cooldowns activos
  const activeCooldowns = Object.entries(state.keyCooldown)
    .filter(([k]) => isKeyCoolingDown(k))
    .map(([k, e]) => {
      const remaining = cooldownCycles(e.reason) - (state.cycle - e.cycle);
      return `${k}(${e.reason.slice(0,2)} ${remaining}c)`;
    });
  if (activeCooldowns.length > 0) {
    log(`Cooldowns activos: ${activeCooldowns.join(" | ")}`);
  }

  const allClosed = state.closed;
  if (allClosed.length > 0) {
    const wins     = allClosed.filter(t => t.pnl > 0);
    const losses   = allClosed.filter(t => t.pnl < 0);
    const totalPnl = allClosed.reduce((s, t) => s + t.pnl, 0);
    const gw       = wins.reduce((s, t) => s + t.pnl, 0);
    const gl       = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf       = gl > 0 ? (gw / gl).toFixed(2) : "∞";
    const wr       = ((wins.length / allClosed.length) * 100).toFixed(1);
    log(`GLOBAL | trades=${allClosed.length} WR=${wr}% PF=${pf} pnl=$${totalPnl.toFixed(2)}`);

    const withMae = allClosed.filter(t => t.mae != null);
    if (withMae.length > 0) {
      const avgMae = withMae.reduce((s, t) => s + t.mae, 0) / withMae.length;
      const avgMfe = withMae.reduce((s, t) => s + t.mfe, 0) / withMae.length;
      log(`MAE/MFE (n=${withMae.length}) | avg MAE=${(avgMae*100).toFixed(1)}% avg MFE=${(avgMfe*100).toFixed(1)}%`);
    }

    const byReason = {};
    for (const t of allClosed) {
      if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 };
      byReason[t.reason].n++; byReason[t.reason].pnl += t.pnl;
    }
    for (const [r, s] of Object.entries(byReason)) log(`  ${r}: ${s.n} trades pnl=$${s.pnl.toFixed(2)}`);
  }
  log(div);
}

// ─── SCHEDULER CON LOCK ───────────────────────────────────────
let cycleRunning = false;

async function runCycle() {
  state.cycle++;
  const t0 = Date.now();
  try {
    const allMarkets = await fetchMarkets();
    if (allMarkets.length === 0) { log("Sin mercados, reintentando...", "WARN"); return; }

    await managePositions(allMarkets);

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
      if (signalOverrideSlugs.size > 0) log(`Override vol/liq para ${signalOverrideSlugs.size} slugs con z≥${CONFIG.ZSCORE_OVERRIDE_THRESHOLD}`);
    }

    const { valid, rejected } = filterMarkets(allMarkets, signalOverrideSlugs);
    const validSlugs = new Set(valid.map(m => m.slug));

    updateHistory(valid);

    const candidates = valid
      .map(m => ({ ...m, signal: computeSignal(m) }))
      .filter(m => m.signal);

    // Contador global de key (v6.2, compartido entre bots)
    const globalOpenByKey = {};
    for (const pos of state.positions) {
      const key = pos.marketKey || marketKey(pos.question, pos.slug);
      globalOpenByKey[key] = (globalOpenByKey[key] || 0) + 1;
    }

    for (const [bot, botConfig] of Object.entries(BOTS)) {
      const botOpenSlugs = new Set(state.positions.filter(p => p.bot === bot).map(p => p.slug));

      const openByCategory = {};
      for (const pos of state.positions.filter(p => p.bot === bot)) {
        const cat = pos.category || marketCategory(pos.question);
        openByCategory[cat] = (openByCategory[cat] || 0) + 1;
      }

      const eligible = candidates
        .filter(c => !botOpenSlugs.has(c.slug))
        .filter(c => c.signal.absZScore >= botConfig.MIN_ZSCORE)
        .filter(c => state.equity[bot] > 10)
        // v6.4: filtro de cooldown adaptativo (antes del sort por calidad)
        .filter(c => {
          const key = marketKey(c.question, c.slug);
          // 1. Cooldown temporal post-cierre
          if (isKeyCoolingDown(key)) return false;
          // 2. Límite de trades por key en 24h
          if (tradesLast24h(key) >= CONFIG.MAX_TRADES_PER_KEY_24H) return false;
          return true;
        })
        .sort((a, b) => b.signal.qualScore - a.signal.qualScore);

      for (const candidate of eligible) {
        if (state.positions.filter(p => p.bot === bot).length >= CONFIG.MAX_OPEN_PER_BOT) break;
        if (botOpenSlugs.has(candidate.slug)) continue;

        const cat      = marketCategory(candidate.question);
        const key      = marketKey(candidate.question, candidate.slug);
        const catLimit = CONFIG.MAX_CATEGORY_POSITIONS[cat] ?? CONFIG.MAX_CATEGORY_POSITIONS.other;

        if ((openByCategory[cat]  || 0) >= catLimit)                     continue;
        if ((globalOpenByKey[key] || 0) >= CONFIG.MAX_POSITIONS_PER_KEY) continue;

        openPosition(bot, candidate, candidate.signal);
        botOpenSlugs.add(candidate.slug);

        openByCategory[cat]    = (openByCategory[cat]    || 0) + 1;
        globalOpenByKey[key]   = (globalOpenByKey[key]   || 0) + 1;
      }
    }

    auditRejected(rejected, allMarkets, validSlugs);
    printReport(allMarkets.length, valid.length, rejected, candidates.length);
    log(`Ciclo completado en ${Date.now() - t0}ms`);

  } catch (err) {
    log(`Error en ciclo: ${err.message}`, "ERR");
    console.error(err.stack);
  } finally {
    await saveState();
  }
}

async function scheduler() {
  if (cycleRunning) {
    log("Ciclo anterior todavía en ejecución, saltando tick", "WARN");
    setTimeout(scheduler, 60_000);
    return;
  }
  cycleRunning = true;
  try {
    await runCycle();
  } finally {
    cycleRunning = false;
    setTimeout(scheduler, CONFIG.CYCLE_INTERVAL_MS);
  }
}

// ─── ARRANQUE ─────────────────────────────────────────────────
log("════════════════════════════════════════════════════════════");
log("MICRODRIFT v6.4 — ADAPTIVE COOLDOWN POR KEY");
log(`Supabase: ${SUPABASE_URL}`);
log(`Capital: $${CONFIG.INITIAL_EQUITY} × 3 bots = $${CONFIG.INITIAL_EQUITY * 3} total`);
log(`Ventana: ${CONFIG.HISTORY_WINDOW}h | MinCiclos: ${CONFIG.MIN_HIST_CYCLES} | Hold: ${CONFIG.MAX_HOLD_MS/3_600_000}h`);
log(`Stop: ${CONFIG.STOP_LOSS_ROI*100}% | TP: ${CONFIG.TAKE_PROFIT_ROI*100}% | Trailing: ${CONFIG.TRAILING_STOP_TRIGGER_ROI*100}%→BE`);
log(`Bots: A(z≥2.0) B(z≥1.8) C(z≥1.5)`);
log(`Diversificación: cat/bot sports≤${CONFIG.MAX_CATEGORY_POSITIONS.sports} politics≤${CONFIG.MAX_CATEGORY_POSITIONS.politics} | key global≤${CONFIG.MAX_POSITIONS_PER_KEY}`);
log(`Cooldown: TP=${CONFIG.COOLDOWN_BY_REASON.TAKE_PROFIT}c SL=${CONFIG.COOLDOWN_BY_REASON.STOP_LOSS}c TO=${CONFIG.COOLDOWN_BY_REASON.TIMEOUT}c | max ${CONFIG.MAX_TRADES_PER_KEY_24H} trades/key/24h`);
log("════════════════════════════════════════════════════════════");
log("AVISO: Esto es PAPER TRADING. No opera con dinero real.");
log("════════════════════════════════════════════════════════════");

loadState().then(() => scheduler());

process.on("uncaughtException",  err    => { log(`Excepción: ${err.message}`, "ERR"); saveState().then(() => process.exit(1)); });
process.on("unhandledRejection", reason => { log(`Rechazo: ${reason}`, "ERR"); saveState(); });
process.on("SIGINT",             ()     => { log("Deteniendo..."); saveState().then(() => process.exit(0)); });

import http from "http";
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const totalPnl       = state.closed.reduce((s, t) => s + t.pnl, 0);
  const activeCooldowns = Object.keys(state.keyCooldown).filter(k => isKeyCoolingDown(k)).length;
  const body = JSON.stringify({
    status:          "running",
    version:         "v6.4-adaptive-cooldown",
    cycle:           state.cycle,
    equity:          state.equity,
    trades:          state.closed.length,
    pnl:             totalPnl.toFixed(2),
    positions:       state.positions.length,
    activeCooldowns,
    uptime:          Math.round(process.uptime()) + "s",
  }, null, 2);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}).listen(PORT, () => log(`HTTP health server escuchando en puerto ${PORT}`));
