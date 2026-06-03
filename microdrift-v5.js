// ==========================================
// POLYMARKET MEAN REVERSION v5
// Basado en resultados reales:
// - Trade 1: Knicks +147% ROI (reversión perfecta)
// - Trade 2: Knicks TIMEOUT -0.03 (capital inmovilizado)
//
// Cambios vs v4.4:
// ① Cierre dinámico: si 3h y ROI<2% y |zscore|<0.5 → cerrar
// ② Filtro tendencia: si precio bajando fuerte → no entrar
// ③ HISTORY_WINDOW 6 → 12
// ④ FEE_RATE 0.02 → 0.005
// ==========================================

import fs from "fs";
import fetch from "node-fetch";

let CONFIG = {
  API: "https://gamma-api.polymarket.com",
  INITIAL_EQUITY: 200,

  PRICE_MIN:    0.20,
  PRICE_MAX:    0.80,
  MIN_VOLUME:   30000,
  MIN_LIQ:      10000,

  RISK_PER_TRADE: 0.02,
  FEES:           0.005,  // ④ fix: 0.5% real

  MAX_OPEN_TRADES:           2,
  MAX_POSITIONS_PER_MARKET:  1,

  // ③ más historia para z-score estable
  HISTORY_WINDOW: 12,

  CYCLE_INTERVAL: 60 * 60 * 1000, // 1 hora

  STOP_LOSS:   0.15,
  TAKE_PROFIT: 0.30,
  HOLD_TIME:   24 * 60 * 60 * 1000, // 24h máximo

  // ① Cierre dinámico
  EARLY_EXIT_MINUTES: 180,  // 3 horas
  EARLY_EXIT_ROI_MAX: 0.02, // si ROI < 2%
  EARLY_EXIT_ZSCORE:  0.5,  // y |zscore| < 0.5 → cerrar

  // ② Filtro tendencia
  SLOPE_THRESHOLD: 0.008,   // si baja >0.8% por ciclo → no entrar
};

const BOTS = {
  A: { MIN_ZSCORE: 2.0 },  // estricto
  B: { MIN_ZSCORE: 1.8 },  // campeón actual — mantener
  C: { MIN_ZSCORE: 1.8 },  // igual que B — no bajar a 1.2
};

// ==========================================
// STATE
// ==========================================

let state = loadState();

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync("state.json", "utf8"));
    log(`✓ Estado cargado | ${Object.keys(BOTS).map(b => `${b}:$${s.equity?.[b]?.toFixed(2)||200}`).join(" ")}`);
    return s;
  } catch {
    log("⚠ Sin estado previo — empezando de cero");
    return {
      cycle:     0,
      history:   {},   // historial de precios por mercado
      positions: [],
      closed:    [],
      equity:    { A: 200, B: 200, C: 200 },
      peak:      { A: 200, B: 200, C: 200 },
    };
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

const ts  = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = msg => console.log(`[${ts()}] ${msg}`);

// ==========================================
// API
// ==========================================

function extractPrice(m) {
  try {
    const raw    = JSON.parse(m.outcomePrices || "[]");
    const prices = (Array.isArray(raw) ? raw : []).map(Number).filter(p => p > 0.001 && p < 0.999);
    if (!prices.length) return Number(m.lastPrice) || 0;
    // Precio más cercano a 0.50 — evita mercados resueltos
    return prices.reduce((a, b) => Math.abs(b-0.5) < Math.abs(a-0.5) ? b : a, prices[0]);
  } catch {
    return Number(m.lastPrice) || 0;
  }
}

async function fetchMarkets() {
  try {
    const r = await fetch(
      `${CONFIG.API}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=50`,
      { headers: { "User-Agent": "PolyMeanRev/5.0" } }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    return data.map(m => ({
      slug:      m.slug || m.id,
      name:      (m.question || "").slice(0, 65),
      price:     extractPrice(m),
      volume:    Number(m.volume24hr) || 0,
      liquidity: Number(m.liquidity)  || 0,
      endDate:   m.endDate || null,
    })).filter(m => m.price > 0 && m.slug);

  } catch (e) {
    log(`❌ API error: ${e.message}`);
    return [];
  }
}

// ==========================================
// FILTROS
// ==========================================

function isValid(m) {
  if (m.price     < CONFIG.PRICE_MIN)  return false;
  if (m.price     > CONFIG.PRICE_MAX)  return false;
  if (m.volume    < CONFIG.MIN_VOLUME) return false;
  if (m.liquidity < CONFIG.MIN_LIQ)    return false;

  // Bloquea mercados que resuelven pronto
  if (m.endDate) {
    const h = (new Date(m.endDate) - Date.now()) / 3600000;
    if (h < 6) return false;
  }

  // Bloquea partidos en directo
  const s = (m.slug || "").toLowerCase();
  const q = (m.name || "").toLowerCase();
  const live = ["vs.","vs ","spread:","game ","bo3","bo5","map ","lck","lec"," g1 "," g2 "];
  if (live.some(k => s.includes(k) || q.includes(k))) return false;

  return true;
}

// ==========================================
// ESTADÍSTICAS DE PRECIO (z-score + slope)
// ==========================================

function updateHistory(markets) {
  for (const m of markets) {
    if (!state.history[m.slug]) state.history[m.slug] = [];
    state.history[m.slug].push(m.price);
    if (state.history[m.slug].length > CONFIG.HISTORY_WINDOW) {
      state.history[m.slug].shift();
    }
  }
}

function getStats(slug) {
  const h = state.history[slug] || [];
  if (h.length < 4) return null;

  const n    = h.length;
  const mean = h.reduce((a, b) => a+b, 0) / n;
  const std  = Math.sqrt(h.reduce((a, b) => a + (b-mean)**2, 0) / n);
  const last = h[n-1];

  // Z-score: cuántas desviaciones estándar está el precio actual de la media
  const zscore = std > 0 ? (last - mean) / std : 0;

  // ② Pendiente: tendencia reciente (últimos 4 puntos)
  // Si es muy negativa → precio bajando fuerte → posible información nueva
  const recent = h.slice(-4);
  const slope  = (recent[recent.length-1] - recent[0]) / recent.length;

  return { mean, std, last, zscore, slope, n };
}

// ==========================================
// SEÑAL DE ENTRADA — mean reversion
// Entra cuando el precio está muy alejado de la media
// y esperamos que vuelva
// ==========================================

function getSignal(slug, price) {
  const stats = getStats(slug);
  if (!stats) return null;

  const { zscore, slope, mean } = stats;

  // ② Filtro de tendencia fuerte — no cazar cuchillos
  // Si el precio lleva bajando consistentemente (slope muy negativo)
  // es probable que sea información nueva, no sobre-reacción
  if (slope < -CONFIG.SLOPE_THRESHOLD) return null;
  if (slope >  CONFIG.SLOPE_THRESHOLD * 2) return null; // también evita pumps

  // Solo entra en reversiones alcistas (precio muy bajo → esperamos suba)
  // zscore muy negativo = precio muy por debajo de la media = oportunidad
  if (zscore < -2.0) {
    return {
      direction: "LONG",
      zscore,
      slope,
      mean,
      reason: `Precio $${price.toFixed(3)} muy bajo vs media $${mean.toFixed(3)} (z=${zscore.toFixed(2)})`,
    };
  }

  // También detecta mercados sobrecomprados para SELL_PROXY
  // (apostar NO cuando el precio subió demasiado)
  if (zscore > 2.0) {
    return {
      direction: "SELL_PROXY",
      zscore,
      slope,
      mean,
      reason: `Precio $${price.toFixed(3)} muy alto vs media $${mean.toFixed(3)} (z=${zscore.toFixed(2)})`,
    };
  }

  return null;
}

// ==========================================
// ABRIR TRADE
// ==========================================

function hasDuplicate(bot, slug) {
  return state.positions.some(p => p.bot === bot && p.slug === slug);
}

function openTrade(bot, m, signal) {
  if (hasDuplicate(bot, m.slug)) return false;

  const botOpen = state.positions.filter(p => p.bot === bot).length;
  if (botOpen >= CONFIG.MAX_OPEN_TRADES) return false;

  const invested = state.equity[bot] * CONFIG.RISK_PER_TRADE;
  const fee      = invested * CONFIG.FEES;
  if (state.equity[bot] < invested + fee) return false;

  state.equity[bot] -= (invested + fee);

  state.positions.push({
    bot,
    slug:      m.slug,
    name:      m.name,
    direction: signal.direction,
    entry:     m.price,
    invested,
    zscore:    signal.zscore,
    slope:     signal.slope,
    mean:      signal.mean,
    peak:      m.price,
    openedAt:  Date.now(),
  });

  log(`🟢 OPEN ${bot} [${signal.direction}] ${m.name.slice(0, 40)}`);
  log(`   @${m.price.toFixed(3)} | $${invested.toFixed(2)} | z=${signal.zscore.toFixed(2)} | ${signal.reason}`);
  return true;
}

// ==========================================
// CERRAR TRADE
// ==========================================

function closeTrade(pos, price, reason) {
  // Para SELL_PROXY: ganamos si el precio baja
  const direction = pos.direction === "SELL_PROXY" ? -1 : 1;
  const roi       = ((price - pos.entry) / pos.entry) * direction;
  const gross     = pos.invested * (1 + roi);
  const fee       = gross * CONFIG.FEES;
  const net       = gross - fee;
  const pnl       = net - pos.invested;

  state.equity[pos.bot] += net;

  // Actualiza peak
  const eq = state.equity[pos.bot];
  if (eq > state.peak[pos.bot]) state.peak[pos.bot] = eq;

  state.closed.push({
    ...pos,
    exit:      price,
    roi,
    pnl,
    reason,
    closedAt:  Date.now(),
  });

  state.positions = state.positions.filter(p => p !== pos);

  log(`${pnl>=0?"💰":"🛑"} CLOSE ${pos.bot} (${reason}) @${pos.entry.toFixed(3)}→@${price.toFixed(3)} | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(2)} | ROI: ${(roi*100).toFixed(1)}%`);
}

// ==========================================
// GESTIONAR TRADES ABIERTOS
// ==========================================

function manage(markets) {
  const now = Date.now();

  for (const p of [...state.positions]) {
    const m = markets.find(x => x.slug === p.slug);
    if (!m) continue;

    const direction = p.direction === "SELL_PROXY" ? -1 : 1;
    const roi       = ((m.price - p.entry) / p.entry) * direction;
    const ageMin    = (now - p.openedAt) / 60000;

    if (m.price > p.peak) p.peak = m.price;

    // Stop loss
    if (roi <= -CONFIG.STOP_LOSS) {
      closeTrade(p, m.price, "STOP_LOSS"); continue;
    }

    // Take profit
    if (roi >= CONFIG.TAKE_PROFIT) {
      closeTrade(p, m.price, "TAKE_PROFIT"); continue;
    }

    // Timeout máximo
    if (now - p.openedAt > CONFIG.HOLD_TIME) {
      closeTrade(p, m.price, "TIMEOUT"); continue;
    }

    // ① CIERRE DINÁMICO — evita capital inmovilizado
    // Si llevamos X horas, el ROI es mínimo Y el z-score ya normalizó
    if (ageMin > CONFIG.EARLY_EXIT_MINUTES) {
      const stats = getStats(p.slug);
      const zNow  = stats ? Math.abs(stats.zscore) : 0;

      if (roi < CONFIG.EARLY_EXIT_ROI_MAX && zNow < CONFIG.EARLY_EXIT_ZSCORE) {
        closeTrade(p, m.price, `EARLY_EXIT(${ageMin.toFixed(0)}min ROI${(roi*100).toFixed(1)}% z${zNow.toFixed(2)})`);
        continue;
      }
    }
  }
}

// ==========================================
// EDGE ANALYZER
// ==========================================

function analyzeEdge() {
  const trades = state.closed;
  if (trades.length < 5) {
    log(`🔬 EDGE: Solo ${trades.length}/5 trades — necesito más datos`);
    return;
  }

  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const wr      = wins.length / trades.length;
  const avgWin  = wins.length   > 0 ? wins.reduce((a,t) => a+t.pnl, 0) / wins.length   : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a,t) => a+t.pnl, 0) / losses.length) : 0;
  const exp     = (wr * avgWin) - ((1-wr) * avgLoss);
  const pf      = avgLoss > 0 ? (wr * avgWin) / ((1-wr) * avgLoss) : 0;
  const status  = exp > 0 ? "✅ EDGE" : "❌ NO_EDGE";

  log(`🔬 ${status} | Exp: ${exp>=0?"+":""}$${exp.toFixed(3)} | WR: ${(wr*100).toFixed(0)}% | PF: ${pf.toFixed(2)} | AvgW: +$${avgWin.toFixed(2)} AvgL: -$${avgLoss.toFixed(2)}`);

  // Por bot
  for (const b of ["A","B","C"]) {
    const bt = trades.filter(t => t.bot === b);
    if (bt.length === 0) continue;
    const bw  = bt.filter(t => t.pnl > 0).length;
    const bpnl = bt.reduce((a,t) => a+t.pnl, 0);
    log(`   BOT ${b}: ${bt.length} trades | WR: ${(bw/bt.length*100).toFixed(0)}% | PnL total: ${bpnl>=0?"+":""}$${bpnl.toFixed(2)}`);
  }
}

// ==========================================
// CICLO PRINCIPAL
// ==========================================

async function cycle() {
  state.cycle++;
  log(`\n════ CICLO ${state.cycle} ════`);

  try {
    const markets  = await fetchMarkets();
    if (!markets.length) {
      log("⚠ Sin mercados");
      return setTimeout(cycle, CONFIG.CYCLE_INTERVAL);
    }

    updateHistory(markets);
    manage(markets);

    const filtered = markets.filter(m => isValid(m));
    log(`✓ ${markets.length} mercados | ${filtered.length} válidos`);

    // Buscar entradas para cada bot
    const used = new Set(state.positions.map(p => p.slug));
    let opened = 0;

    for (const b of ["A","B","C"]) {
      const botOpen = state.positions.filter(p => p.bot === b).length;
      if (botOpen >= CONFIG.MAX_OPEN_TRADES) continue;

      const candidates = filtered
        .filter(m => !hasDuplicate(b, m.slug))
        .map(m => {
          const signal = getSignal(m.slug, m.price);
          return signal ? { m, signal } : null;
        })
        .filter(Boolean)
        .filter(x => Math.abs(x.signal.zscore) >= BOTS[b].MIN_ZSCORE)
        .sort((a, b) => Math.abs(b.signal.zscore) - Math.abs(a.signal.zscore));

      if (candidates.length === 0) continue;

      const best = candidates[0];
      if (openTrade(b, best.m, best.signal)) opened++;
    }

    if (opened === 0) log(`ℹ Sin señales válidas`);

    // Stats
    log("");
    for (const b of ["A","B","C"]) {
      const eq  = state.equity[b];
      const pnl = eq - CONFIG.INITIAL_EQUITY;
      const dd  = state.peak[b] > 0 ? ((state.peak[b]-eq)/state.peak[b]*100).toFixed(1) : "0.0";
      const pos = state.positions.filter(p => p.bot === b).length;
      log(`BOT ${b}(z≥${BOTS[b].MIN_ZSCORE}) | Equity: $${eq.toFixed(2)} | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(2)} | DD: ${dd}% | Abiertos: ${pos}`);
    }

    analyzeEdge();
    saveState();

  } catch (e) {
    log(`❌ ERR: ${e.message}`);
    saveState();
  }

  setTimeout(cycle, CONFIG.CYCLE_INTERVAL);
}

// ==========================================
// START
// ==========================================

process.on("uncaughtException", e => { log(`FATAL: ${e.message}`); saveState(); process.exit(1); });
process.on("unhandledRejection", e => { log(`REJECTION: ${e}`); saveState(); });

log("🚀 PolyMeanReversion v5");
log(`   Bots: ${Object.entries(BOTS).map(([k,v])=>`${k}(z≥${v.MIN_ZSCORE})`).join(" ")}`);
log(`   HistoryWindow: ${CONFIG.HISTORY_WINDOW} | Fees: ${CONFIG.FEES*100}% | Ciclo: 1h`);
log(`   EarlyExit: ${CONFIG.EARLY_EXIT_MINUTES}min si ROI<${CONFIG.EARLY_EXIT_ROI_MAX*100}% y |z|<${CONFIG.EARLY_EXIT_ZSCORE}`);
cycle();
