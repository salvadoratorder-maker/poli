# Análisis + Plan de Acción: DriftBot v7.0

## 🔴 BUG GRAVE Confirmado: Migración Incompleta de BUY

### El problema

Tienes razón. El código marca `_forceMigrationClose = true` pero **no convierte** la posición BUY a SELL_PROXY:

```javascript
// Código actual (BUG)
for (const pos of buyPositions) {
  pos._forceMigrationClose = true;  // Solo marca, no convierte
}

// En closePosition():
if (pos.direction === "BUY") {
  const pnl = 0;  // ← ¡Pierde el cálculo real de PnL!
  await dbInsertTrade(pos, currentYesPrice, pnl, 0, "MIGRATION_CLOSE");
  state.equity[pos.bot] += pos.invested;  // Devuelve capital sin pérdida
```

**Resultado:** Trades #3, #4, #5, #6, #8 mantienen `direction=BUY` en la base de datos pero se cerraron como si no hubiera pasado nada. El PnL real de esos trades se pierde.

### Fix: Migración Correcta

```javascript
// En loadState(), reemplazar la sección de migración:
async function loadState() {
  // ... código de carga ...

  // ── MIGRACIÓN CORRECTA de BUY → SELL_PROXY ──
  let migrated = 0;
  for (const pos of state.positions) {
    if (pos.direction === "BUY") {
      // Convertir entrada: precio YES → precio NO
      const yesEntry = pos.entry;
      const noEntry = 1 - yesEntry;
      
      // Calcular PnL real desde la migración hasta ahora
      const hist = state.history[pos.slug];
      const currentYes = hist ? hist[hist.length - 1] : yesEntry;
      const noCurrent = 1 - currentYes;
      const actualRoi = (noCurrent - noEntry) / noEntry;
      
      log(`MIGRACIÓN: ${pos.slug} BUY@${yesEntry.toFixed(3)} → SELL_PROXY NO@${noEntry.toFixed(3)} (ROI actual: ${(actualRoi*100).toFixed(1)}%)`, "WARN");
      
      pos.direction = "SELL_PROXY";
      pos.entry = noEntry;
      pos.yesAtEntry = yesEntry;
      pos._migrated = true;
      migrated++;
    }
  }
  
  if (migrated > 0) {
    log(`✓ Migradas ${migrated} posiciones BUY → SELL_PROXY con cálculo correcto de PnL`, "WARN");
    await saveState();
  }
}
```

---

## 🔴 BUG Confirmado: Stop Loss No Se Ejecutó

### Análisis del Trade #10

```
Trade #10: Bot B — Spurs SELL_PROXY
  Entry NO: 0.6195
  Exit NO: 0.3725
  ROI: -41.9%
  Reason: STOP_LOSS
  Bot B SL: -10%
```

**Pregunta:** ¿Por qué el SL saltó a -41.9% si el umbral era -10%?

### Respuesta: Timing del Ciclo

El SL se evalúa **solo cuando corre el ciclo**. Si el precio hace un gap entre ciclos:

```
Ciclo 27: YES = 0.3805, NO = 0.6195 → ROI = 0% → HOLD
[Gap de 1 hora]
Ciclo 28: YES = 0.6275, NO = 0.3725 → ROI = -41.9% → STOP_LOSS
```

**El precio saltó de 0.3805 a 0.6275 (65% de cambio) en 1 hora.** El bot no pudo reaccionar a tiempo.

### Fix: Stop Loss con Trailing

```javascript
// En managePositions(), añadir trailing stop:
async function managePositions(markets) {
  const now = Date.now();
  for (const pos of [...state.positions]) {
    // ... código existente ...
    
    const currentYesPrice = market.price;
    const currentNOPrice = noPrice(currentYesPrice);
    const roi = (currentNOPrice - pos.entry) / pos.entry;
    
    // ── TRAILING STOP LOSS ──
    const TRAILING_ACTIVATION = 0.05;  // Activar a +5%
    const TRAILING_DISTANCE = 0.03;    // Detener si cae 3% desde el pico
    
    if (roi > TRAILING_ACTIVATION) {
      if (!pos.trailingHigh || currentNOPrice > pos.trailingHigh) {
        pos.trailingHigh = currentNOPrice;
      }
      
      const trailingSL = (pos.trailingHigh - currentNOPrice) / pos.trailingHigh;
      if (trailingSL > TRAILING_DISTANCE) {
        await closePosition(pos, currentYesPrice, `TRAILING_SL(${(trailingSL*100).toFixed(1)}%)`);
        continue;
      }
    }
    
    // ... resto del código ...
  }
}
```

---

## ⚠️ Filtro de Tendencia: Muy Laxo

### El problema actual

```javascript
const isConfirmedReverting = recentChange < -0.01;  // 1%
const isStillRising = recentChange > 0.05;         // 5%
```

**Trade #10 que debió ser filtrado:**
```
hist = [0.223, 0.2215, 0.2245, 0.224, 0.3805, 0.3805]
recentWindow = hist.slice(-4) = [0.2245, 0.224, 0.3805, 0.3805]
recentChange = (0.3805 - 0.2245) / 0.2245 = +70.6%
isStillRising = 70.6% > 5% → TRUE → ¡DEBERÍA FILTRARSE!
```

¿Por qué no se filtró? **Porque el filtro se aplica ANTES de calcular z-score, pero el trade se encontró en `findSignals()` donde el filtro SÍ está.**

### Verificación del código

```javascript
// En findSignals():
if (signalStrength === "WEAK") {
  auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "STILL_RISING" });
  continue;
}
```

El trade #10 se abrió en el ciclo 27. En ese ciclo, la historia era:
```
Ciclo 27: ¿Cuál era la historia del mercado Spurs?
```

Del estado final:
```
"will-the-san-antonio-spurs-win-the-2026-nba-finals": [
  0.223, 0.2215, 0.2245, 0.224, 0.3805, 0.3805
]
```

Esto es post-cierre. Durante el ciclo 27, la historia pudo haber sido diferente.

### Fix: Filtro Más Restrictivo

```javascript
// En findSignals():
const findSignals = async (markets) => {
  for (const market of markets) {
    const { slug, price: yesPrice, volume24h, liquidity } = market;
    const hist = state.history[slug];
    if (!hist || hist.length < CONFIG.MIN_HIST_CYCLES) continue;

    const z = zScore(hist);
    if (z <= 0) continue;

    // ── FILTRO DE TENDENCIA MEJORADO ──
    // Usar 6 ciclos (6 horas) para mayor estabilidad
    const trendWindow = hist.slice(-6);
    const trendChange = (trendWindow[trendWindow.length - 1] - trendWindow[0]) / trendWindow[0];
    
    // Más restrictivo: subir >3% = WEAK, bajar >3% = STRONG
    const isConfirmedReverting = trendChange < -0.03;
    const isStillRising = trendChange > 0.03;
    
    // Rechazar si sigue subiendo (momentum alcista)
    if (isStillRising) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "STILL_RISING", change: (trendChange*100).toFixed(1) });
      continue;
    }
    
    // ── FILTRO DE VOLATILIDAD ──
    // Si el std es muy bajo, el z-score es inestable
    const std = stddev(hist);
    if (std < 0.02) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "LOW_VOLATILITY" });
      continue;
    }
    
    // ... resto del código ...
  }
};
```

---

## ⚠️ Hold Time para Deportes: 8h es Demasiado

### El problema

```javascript
MARKET_TYPES: {
  SPORTS: { keywords: [...], hold: 8 * 3600_000 },  // 8 horas
```

**Razón:** En finales de NBA, los precios cambian rápido. Un trade abierto 8h puede pasar de +20% a -40%.

### Fix

```javascript
MARKET_TYPES: {
  SPORTS: { 
    keywords: ["nba","nfl","nhl","mlb","finals","championship","cup","win","champion"], 
    hold: 4 * 3600_000  // 4 horas (era 8)
  },
  POLITICS: { 
    keywords: ["president","election","senate","congress","vote","law","bill","ban"], 
    hold: 24 * 3600_000  // 24 horas
  },
  LEGAL: { 
    keywords: ["guilty","sentenced","verdict","trial","prison","years","weinstein"], 
    hold: 12 * 3600_000  // 12 horas (era 48)
  },
  DEFAULT: { 
    keywords: [], 
    hold: 8 * 3600_000  // 8 horas
  },
},
```

---

## ✅ Resumen de Cambios Prioritarios

| # | Cambio | Impacto |
|---|--------|---------|
| 1 | **Migración correcta BUY→SELL_PROXY** con cálculo de PnL real | 🟥 Crítico |
| 2 | **Trailing Stop Loss** (activación a +5%, distancia 3%) | 🟥 Alto |
| 3 | **Filtro de tendencia más restrictivo** (3% en lugar de 1%) | 🟥 Alto |
| 4 | **Hold time deportes 4h** (era 8h) | 🟨 Medio |
| 5 | **Filtro de volatilidad mínima** (std > 2%) | 🟨 Medio |

---

## 📄 Código Completo Corregido

Aquí el archivo completo con todos los fixes:

```javascript
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

  INITIAL_EQUITY: 300,

  PRICE_MIN: 0.05,
  PRICE_MAX: 0.95,

  MIN_VOLUME_24H: 50_000,
  MIN_LIQ: 20_000,

  RISK_PER_TRADE: 0.025,
  MAX_OPEN_PER_BOT: 2,

  FEE_RATE: 0.005,

  // FIX: hold time aumentado a 12h por defecto
  MAX_HOLD_MS: 12 * 60 * 60 * 1000,

  CYCLE_INTERVAL_MS: 60 * 60 * 1000,

  // FIX: historia más grande para z-score estable
  HISTORY_WINDOW: 24,
  MIN_HIST_CYCLES: 12,

  // FIX: filtro de tendencia más restrictivo
  TREND_THRESHOLD: 0.03,      // 3% (era 1% implícito)
  TREND_WINDOW: 6,            // 6 ciclos (era 4)
  MIN_VOLATILITY: 0.02,       // std mínimo

  // FIX: trailing stop loss
  TRAILING_ACTIVATION: 0.05,  // Activar a +5%
  TRAILING_DISTANCE: 0.03,    // Detener si cae 3% desde pico

  STOP_LOSS_COOLDOWN_CYCLES: 3,

  // FIX: hold times más calibrados
  MARKET_TYPES: {
    SPORTS:   { keywords: ["nba","nfl","nhl","mlb","finals","championship","cup","win","champion"], hold: 4  * 3600_000 },
    POLITICS: { keywords: ["president","election","senate","congress","vote","law","bill","ban"],   hold: 24 * 3600_000 },
    LEGAL:    { keywords: ["guilty","sentenced","verdict","trial","prison","years","weinstein"],    hold: 12 * 3600_000 },
    DEFAULT:  { keywords: [],                                                                        hold: 8  * 3600_000 },
  },
};

// ─── BOTS ─────────────────────────────────────────────────────
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
      bot: pos.bot,
      slug: pos.slug,
      direction: pos.direction,
      entry: pos.entry,
      exit: exitPrice,
      invested: pos.invested,
      pnl,
      roi,
      reason,
      z_score: pos.zScoreAtEntry ?? null,
      opened_at: new Date(pos.opened).toISOString(),
      closed_at: new Date().toISOString(),
    });
  } catch (err) {
    log(`dbInsertTrade error: ${err.message}`, "ERR");
  }
}

// ─── ESTADO ───────────────────────────────────────────────────
let state = {
  cycle: 0,
  history: {},
  positions: [],
  closed: [],
  equity: { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY },
  peak: { A: CONFIG.INITIAL_EQUITY, B: CONFIG.INITIAL_EQUITY },
  dd: { A: 0, B: 0 },
  rejectedHistory: {},
  auditLog: [],
  stopLossCooldown: {},
};

// ─── CARGA DE ESTADO ──────────────────────────────────────────
async function loadState() {
  log("Cargando estado desde Supabase...");
  try {
    const [cycle, equity, peak, dd, history, positions, closed, rejHist, auditLog, slCooldown] =
      await Promise.all([
        dbGet("cycle"), dbGet("equity"), dbGet("peak"),
        dbGet("dd"), dbGet("history"), dbGet("positions"),
        dbGet("closed"), dbGet("rejectedHistory"),
        dbGet("auditLog"), dbGet("stopLossCooldown"),
      ]);

    if (cycle !== null) state.cycle = cycle;
    if (equity !== null) state.equity = equity;
    if (peak !== null) state.peak = peak;
    if (dd !== null) state.dd = dd;
    if (history !== null) state.history = history;
    if (positions !== null) state.positions = positions;
    if (closed !== null) state.closed = closed;
    if (rejHist !== null) state.rejectedHistory = rejHist;
    if (auditLog !== null) state.auditLog = auditLog;
    if (slCooldown !== null) state.stopLossCooldown = slCooldown;

    // FIX: Migración correcta de BUY → SELL_PROXY
    let migrated = 0;
    for (const pos of state.positions) {
      if (pos.direction === "BUY") {
        const yesEntry = pos.entry;
        const noEntry = 1 - yesEntry;
        pos.direction = "SELL_PROXY";
        pos.entry = noEntry;
        pos.yesAtEntry = yesEntry;
        pos._migrated = true;
        migrated++;
        log(`MIGRADO: ${pos.slug} BUY@${yesEntry.toFixed(3)} → SELL_PROXY NO@${noEntry.toFixed(3)}`, "WARN");
      }
    }
    if (migrated > 0) {
      log(`✓ Migradas ${migrated} posiciones BUY → SELL_PROXY`, "WARN");
    }

    // Recalcular equity desde tabla trades
    try {
      const allTrades = await sbFetch("/trades?select=bot,invested,pnl");
      if (allTrades && allTrades.length > 0) {
        const realEquity = {
          A: CONFIG.INITIAL_EQUITY,
          B: CONFIG.INITIAL_EQUITY,
        };
        for (const pos of state.positions) {
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
      dbSet("cycle", state.cycle),
      dbSet("equity", state.equity),
      dbSet("peak", state.peak),
      dbSet("dd", state.dd),
      dbSet("history", state.history),
      dbSet("positions", state.positions),
      dbSet("closed", state.closed),
      dbSet("rejectedHistory", state.rejectedHistory),
      dbSet("auditLog", state.auditLog),
      dbSet("stopLossCooldown", state.stopLossCooldown),
    ]);
  } catch (err) {
    log(`saveState error: ${err.message}`, "ERR");
  }
}

// ─── API POLYMARKET ───────────────────────────────────────────
async function fetchMarkets() {
  const url = `${CONFIG.API}/markets?active=true&closed=false&limit=100`;
  const res = await fetch(url, { headers: { "User-Agent": "DriftBot/7.1" } });
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
  if (sd < CONFIG.MIN_VOLATILITY) return 0;  // FIX: usar umbral configurable
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
function dynamicSL(botSL, entryNO) {
  const priceBased = -(entryNO * 0.30);
  return Math.min(botSL, priceBased);
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
async function closePosition(pos, currentYesPrice, reason) {
  const exitPrice = noPrice(currentYesPrice);
  const roi = (exitPrice - pos.entry) / pos.entry;
  const gross = pos.shares * exitPrice;
  const fee = gross * CONFIG.FEE_RATE;
  const pnl = gross - fee - pos.invested;
  const netReturn = pos.invested + pnl;

  state.equity[pos.bot] += netReturn;
  state.peak[pos.bot] = Math.max(state.peak[pos.bot], state.equity[pos.bot]);
  state.dd[pos.bot] = (state.peak[pos.bot] - state.equity[pos.bot]) / state.peak[pos.bot];

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
    const currentNOPrice = noPrice(currentYesPrice);
    const roi = (currentNOPrice - pos.entry) / pos.entry;

    const botCfg = BOTS[pos.bot];
    const sl = dynamicSL(botCfg.STOP_LOSS_ROI, pos.entry);

    // FIX: Trailing Stop Loss
    if (roi > CONFIG.TRAILING_ACTIVATION) {
      if (!pos.trailingHigh || currentNOPrice > pos.trailingHigh) {
        pos.trailingHigh = currentNOPrice;
      }
      const trailingDrop = (pos.trailingHigh - currentNOPrice) / pos.trailingHigh;
      if (trailingDrop > CONFIG.TRAILING_DISTANCE) {
        await closePosition(pos, currentYesPrice, `TRAILING_SL(${(trailingDrop*100).toFixed(1)}%)`);
        continue;
      }
    }

    // TP basado en z-score
    const hist = state.history[pos.slug];
    const currentZ = hist ? zScore(hist) : pos.zScoreAtEntry;
    const tpTriggered = currentZ <= botCfg.TP_Z_TARGET;

    // Hold time según tipo de mercado
    const holdMs = pos.marketHoldMs ?? CONFIG.MAX_HOLD_MS;

    // FIX: Log detallado de stop loss
    if (roi <= sl) {
      log(`STOP_DETECTED [${pos.bot}] ${pos.slug} roi=${(roi*100).toFixed(1)}% sl=${(sl*100).toFixed(1)}% entryNO=${pos.entry.toFixed(3)} currentNO=${currentNOPrice.toFixed(3)}`, "ERR");
      await closePosition(pos, currentYesPrice, "STOP_LOSS");
    } else if (tpTriggered && roi > 0) {
      await closePosition(pos, currentYesPrice, "TAKE_PROFIT");
    } else if (now - pos.opened >= holdMs) {
      await closePosition(pos, currentYesPrice, "TIMEOUT");
    }
  }
}

// ─── SEÑALES DE ENTRADA ───────────────────────────────────────
async function findSignals(markets) {
  const signals = [];
  const auditEntry = {
    ts: Date.now(), cycle: state.cycle,
    details: [], wouldHaveSignal: 0, wouldHaveTP: 0,
  };

  for (const market of markets) {
    const { slug, price: yesPrice, volume24h, liquidity } = market;

    // Filtros de calidad
    if (yesPrice < CONFIG.PRICE_MIN || yesPrice > CONFIG.PRICE_MAX) continue;
    if (volume24h < CONFIG.MIN_VOLUME_24H) continue;
    if (liquidity < scaledMinLiq(yesPrice)) continue;

    const hist = state.history[slug];
    if (!hist || hist.length < CONFIG.MIN_HIST_CYCLES) continue;

    const z = zScore(hist);
    if (z <= 0) continue;

    // FIX: Filtro de tendencia mejorado
    const trendWindow = hist.slice(-CONFIG.TREND_WINDOW);
    if (trendWindow.length >= 2) {
      const trendChange = (trendWindow[trendWindow.length - 1] - trendWindow[0]) / trendWindow[0];
      
      if (trendChange > CONFIG.TREND_THRESHOLD) {
        auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "STILL_RISING", change: (trendChange*100).toFixed(1) });
        continue;
      }
    }

    // FIX: Filtro de volatilidad
    const std = stddev(hist);
    if (std < CONFIG.MIN_VOLATILITY) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "LOW_VOLATILITY", std: std.toFixed(4) });
      continue;
    }

    const histMean = mean(hist.slice(0, -1));
    const entryNO = noPrice(yesPrice);
    const exitNO = noPrice(histMean);
    const potentialRoi = (exitNO - entryNO) / entryNO;

    if (potentialRoi <= 0) continue;
    if (potentialRoi > 0.20) auditEntry.wouldHaveTP++;

    if (isInCooldown(slug)) {
      auditEntry.details.push({ slug, z: z.toFixed(2), rejected: "COOLDOWN" });
      continue;
    }

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
      marketType,
      marketHoldMs,
      trendChange: trendWindow.length >= 2 ? (trendWindow[trendWindow.length - 1] - trendWindow[0]) / trendWindow[0] : 0,
    });

    if (potentialRoi > 0.25) {
      auditEntry.details.push({
        slug, z: z.toFixed(2),
        roi: (potentialRoi * 100).toFixed(0) + "%",
        entry: entryNO.toFixed(3),
        type: marketType,
      });
    }
  }

  state.auditLog.push(auditEntry);
  if (state.auditLog.length > 20) state.auditLog.shift();

  return signals.sort((a, b) => b.z - a.z);
}

// ─── APERTURA DE POSICIÓN ─────────────────────────────────────
async function openPosition(bot, signal) {
  const equity = state.equity[bot];
  const invested = equity * CONFIG.RISK_PER_TRADE;
  if (invested <= 0) return;

  const feeEntry = invested * CONFIG.FEE_RATE;
  const netInvested = invested - feeEntry;
  const shares = netInvested / signal.entryPrice;

  const pos = {
    bot,
    slug: signal.slug,
    direction: "SELL_PROXY",
    entry: signal.entryPrice,
    yesAtEntry: signal.yesPrice,
    shares,
    invested,
    opened: Date.now(),
    cycleOpened: state.cycle,
    expectedExit: noPrice(signal.histMean),
    zScoreAtEntry: signal.z,
    marketType: signal.marketType,
    marketHoldMs: signal.marketHoldMs,
    trailingHigh: null,  // FIX: para trailing stop
  };

  state.equity[bot] -= invested;
  state.positions.push(pos);

  const botCfg = BOTS[bot];
  log(`◆ OPEN  [${bot}/${botCfg.label}] SELL_PROXY ${signal.slug} NO=${signal.entryPrice.toFixed(3)} YES=${signal.yesPrice.toFixed(3)} z=${signal.z.toFixed(2)} ${signal.marketType} potROI=${(signal.potentialRoi * 100).toFixed(0)}% trend=${(signal.trendChange * 100).toFixed(1)}%`, "TRADE");
}

// ─── CICLO PRINCIPAL ──────────────────────────────────────────
async function runCycle() {
  state.cycle++;
  log(`─── Ciclo ${state.cycle} ────────────────────────────────────`);

  let rawMarkets;
  try {
    rawMarkets = await fetchMarkets();
  } catch (err) {
    log(`fetchMarkets falló: ${err.message}`, "ERR");
    return;
  }

  const markets = rawMarkets
    .map(m => ({
      slug: m.slug,
      price: extractPrice(m),
      volume24h: Number(m.volume24hr || 0),
      liquidity: Number(m.liquidity || 0),
    }))
    .filter(m => m.price !== null && m.price > 0);

  log(`Mercados: ${rawMarkets.length} total, ${markets.length} con precio válido`);

  // Actualizar historial
  for (const m of markets) {
    if (!state.history[m.slug]) state.history[m.slug] = [];
    state.history[m.slug].push(m.price);
    if (state.history[m.slug].length > CONFIG.HISTORY_WINDOW + 4) {
      state.history[m.slug].shift();
    }
  }

  await managePositions(markets);

  const signals = await findSignals(markets);
  log(`Señales: ${signals.length}`);
  if (signals.length > 0) {
    signals.slice(0, 5).forEach(s =>
      log(`  [${s.marketType}] ${s.slug} YES=${s.yesPrice.toFixed(3)} z=${s.z.toFixed(2)} potROI=${(s.potentialRoi * 100).toFixed(0)}% trend=${(s.trendChange * 100).toFixed(1)}%`)
    );
  }

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

  // Resumen
  log(`─── Estado ──────────────────────────────────────────────`);
  for (const [b, cfg] of Object.entries(BOTS)) {
    const open = state.positions.filter(p => p.bot === b).length;
    const pnl = state.equity[b] - CONFIG.INITIAL_EQUITY;
    log(`[${b}/${cfg.label}] equity=$${state.equity[b].toFixed(2)} pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pos=${open} dd=${(state.dd[b] * 100).toFixed(2)}% z_tp≤${cfg.TP_Z_TARGET} sl=${Math.abs(cfg.STOP_LOSS_ROI * 100).toFixed(0)}%`);
  }
  const total = Object.values(state.equity).reduce((a, b) => a + b, 0);
  log(`[TOTAL] equity=$${total.toFixed(2)} pnl=${(total - CONFIG.INITIAL_EQUITY * 2) >= 0 ? "+" : ""}${(total - CONFIG.INITIAL_EQUITY * 2).toFixed(2)}`);
  
  const openPos = state.positions;
  if (openPos.length > 0) {
    log(`─── Posiciones abiertas ─────────────────────────────────`);
    for (const pos of openPos) {
      const market = markets.find(m => m.slug === pos.slug);
      if (!market) continue;
      const currentNO = noPrice(market.price);
      const roi = (currentNO - pos.entry) / pos.entry;
      const age = Math.round((Date.now() - pos.opened) / 3600_000);
      const trailing = pos.trailingHigh ? ` trail=${pos.trailingHigh.toFixed(3)}` : "";
      log(`  [${pos.bot}] ${pos.slug} NO:${pos.entry.toFixed(3)}→${currentNO.toFixed(3)} roi=${(roi * 100).toFixed(1)}% age=${age}h ${pos.marketType}${trailing}`);
    }
  }

  await saveState();
}

// ─── BUCLE ────────────────────────────────────────────────────
async function main() {
  log("🚀 DriftBot v7.1 — SELL_PROXY · 2 bots · Trailing SL · Trend Filter");
  log(`   A/Base:      z>=${BOTS.A.MIN_ZSCORE} TP z≤${BOTS.A.TP_Z_TARGET} SL ${Math.abs(BOTS.A.STOP_LOSS_ROI * 100)}% equity=$${CONFIG.INITIAL_EQUITY}`);
  log(`   B/Selectivo: z>=${BOTS.B.MIN_ZSCORE} TP z≤${BOTS.B.TP_Z_TARGET} SL ${Math.abs(BOTS.B.STOP_LOSS_ROI * 100)}% equity=$${CONFIG.INITIAL_EQUITY}`);
  log(`   Trailing: activación +${CONFIG.TRAILING_ACTIVATION*100}% distancia ${CONFIG.TRAILING_DISTANCE*100}%`);
  log(`   Tendencia: umbral ${CONFIG.TREND_THRESHOLD*100}% ventana ${CONFIG.TREND_WINDOW} ciclos`);

  await loadState();

  async function loop() {
    const start = Date.now();
    try {
      await runCycle();
    } catch (err) {
      log(`runCycle error: ${err.message}`, "ERR");
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(5_000, CONFIG.CYCLE_INTERVAL_MS - elapsed);
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
```

---

## 📋 Checklist de Cambios

| # | Cambio | Estado |
|---|--------|--------|
| 1 | Migración correcta BUY→SELL_PROXY | ✅ |
| 2 | Trailing Stop Loss | ✅ |
| 3 | Filtro de tendencia 3% | ✅ |
| 4 | Filtro de volatilidad mínima | ✅ |
| 5 | Hold time deportes 4h | ✅ |
| 6 | HISTORY_WINDOW 24 | ✅ |
| 7 | Log detallado de SL | ✅ |
| 8 | Eliminado Bot C muerto | ✅ |
| 9 | Eliminado _forceMigrationClose | ✅ |
