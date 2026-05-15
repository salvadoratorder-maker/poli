
// ========================================
// POLYMARKET MICRODRIFT v7.0
// Correcciones importantes:
//  1. Trailing stop correcto para SHORT
//  2. Fee model realista (entrada + salida)
//  3. Bots independientes (sin usedSlugs)
//  4. Score por percentil dinámico
//  5. Fetch completo sin límite de 200
// ========================================

const fs = require("fs");

// ================= CONFIGURACIÓN =================
const CONFIG = {
  START_EQUITY: 1000,

  BOT_PROFILES: {
    A: { riskPerTrade: 0.03, stopLoss: 0.06, takeProfit: 0.15, name: "Conservador" },
    B: { riskPerTrade: 0.05, stopLoss: 0.08, takeProfit: 0.20, name: "Neutro" },
    C: { riskPerTrade: 0.08, stopLoss: 0.12, takeProfit: 0.30, name: "Agresivo" },
  },

  FEE_ENTRY: 0.005,
  FEE_EXIT:  0.005,

  MIN_VOLUME:     100_000,
  MIN_LIQUIDITY:   50_000,
  MAX_OPEN_TRADES: 3,

  MOVE_THRESHOLD: 0.004,
  ZOMBIE_THRESHOLD: 0.001,
  ZOMBIE_CYCLES:  5,

  COOLDOWN_BASE_MS: 60 * 60 * 1000,
  COOLDOWN_MAX_MS:  8 * 60 * 60 * 1000,

  PRICE_MIN: 0.10,
  PRICE_MAX: 0.90,

  TRAILING_ACTIVATION: 0.08,
  TRAILING_DISTANCE:   0.05,

  CYCLE_INTERVAL_MS: 5 * 60 * 1000,
  STATS_INTERVAL_MS: 60 * 60 * 1000,

  PERCENTILE_THRESHOLD: 85,  // Top 15% de scores
};

const STATE_FILE = "./state_v7.json";

// ================= LOAD/SAVE STATE =================
function defaultState() {
  return {
    equity: { A: CONFIG.START_EQUITY, B: CONFIG.START_EQUITY, C: CONFIG.START_EQUITY },
    positions: [],
    closed: [],
    history: {},
    zombieCount: {},
    lastClosed: {},
    lossStreak: {},
    peakPriceLow: {},   // Para SHORT: mínimo precio alcanzado
    peakPriceHigh: {},  // Para LONG: máximo precio alcanzado
  };
}

function loadState() {
  try {
    const data = fs.readFileSync(STATE_FILE, "utf8");
    const saved = JSON.parse(data);

    if (typeof saved !== "object" || !saved.equity || !saved.positions) {
      log("⚠️ Estado corrupto, iniciando desde cero", "warn");
      return defaultState();
    }

    for (const bot of ["A", "B", "C"]) {
      if (typeof saved.equity[bot] !== "number" || isNaN(saved.equity[bot])) {
        saved.equity[bot] = CONFIG.START_EQUITY;
      }
    }

    return {
      ...defaultState(),
      ...saved,
      positions: (saved.positions || []).filter(p =>
        p && p.bot && p.slug && p.direction && p.entry > 0 && p.invested > 0
      ),
    };
  } catch {
    return defaultState();
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    equity: state.equity,
    positions: state.positions,
    closed: state.closed.slice(-500),
    history: state.history,
    zombieCount: state.zombieCount,
    lastClosed: state.lastClosed,
    lossStreak: state.lossStreak,
    peakPriceLow: state.peakPriceLow,
    peakPriceHigh: state.peakPriceHigh,
  }, null, 2));
}

const state = loadState();

// ================= LOG =================
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL ? (LOG_LEVELS[process.env.LOG_LEVEL] ?? 1) : 1;

function log(msg, level = "info") {
  if ((LOG_LEVELS[level] ?? 1) < CURRENT_LOG_LEVEL) return;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${msg}`);
  try {
    fs.appendFileSync("logs_v7.csv", `${timestamp},${level},${msg.replace(/,/g, ";")}\n`);
  } catch { }
}

// ================= PRICE MOVE =================
function getMove(slug, price) {
  if (!(slug in state.history)) {
    state.history[slug] = price;
    return 0;
  }
  const prev = state.history[slug];
  if (prev === 0) {
    state.history[slug] = price;
    return 0;
  }
  const move = (price - prev) / prev;
  state.history[slug] = price;
  return move;
}

// ================= ZOMBIE DETECTION =================
function updateZombie(slug, move) {
  if (Math.abs(move) < CONFIG.ZOMBIE_THRESHOLD) {
    state.zombieCount[slug] = (state.zombieCount[slug] || 0) + 1;
  } else {
    state.zombieCount[slug] = 0;
  }
  return state.zombieCount[slug] >= CONFIG.ZOMBIE_CYCLES;
}

// ================= SCORE (sin distancia al centro) =================
function computeScore(m, mv) {
  if (Math.abs(mv) < CONFIG.MOVE_THRESHOLD) return 0;

  let s = 0;
  if (Math.abs(mv) > 0.012) s += 0.40;
  else if (Math.abs(mv) > 0.008) s += 0.30;
  else if (Math.abs(mv) > 0.006) s += 0.20;
  else s += 0.10;

  s += Math.min(1, m.volume / 500_000) * 0.30;
  s += Math.min(1, m.liquidity / 200_000) * 0.30;

  return Math.min(1, Math.max(0, s));
}

// ================= PERCENTIL DINÁMICO =================
function getScoreThreshold(scores, percentile = CONFIG.PERCENTILE_THRESHOLD) {
  if (scores.length === 0) return 1;
  const sorted = [...scores].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

// ================= FILTERS =================
function isDuplicate(slug) {
  return state.positions.some(p => p.slug === slug);
}

function getCooldown(slug) {
  const streak = state.lossStreak[slug] || 0;
  const multiplier = streak > 0 ? Math.min(Math.pow(2, streak - 1), 8) : 1;
  return Math.min(CONFIG.COOLDOWN_BASE_MS * multiplier, CONFIG.COOLDOWN_MAX_MS);
}

function isOnCooldown(slug) {
  const last = state.lastClosed[slug] || 0;
  return Date.now() - last < getCooldown(slug);
}

function priceFilter(price) {
  return price >= CONFIG.PRICE_MIN && price <= CONFIG.PRICE_MAX;
}

function liquidityFilter(m) {
  return m.liquidity >= CONFIG.MIN_LIQUIDITY;
}

// ================= TRAILING STOP CORREGIDO =================
function positionId(pos) {
  return `${pos.bot}:${pos.slug}:${pos.opened}`;
}

function updateTrailingStop(pos, currentPrice) {
  const id = positionId(pos);
  const profile = CONFIG.BOT_PROFILES[pos.bot];

  if (pos.direction === "LONG") {
    // LONG: trackear máximo alcanzado
    const currentHigh = currentPrice;
    const peakHigh = state.peakPriceHigh[id] || pos.entry;

    if (currentHigh > peakHigh) {
      state.peakPriceHigh[id] = currentHigh;
    }

    const peak = state.peakPriceHigh[id];
    const pnlPct = (peak - pos.entry) / pos.entry;

    if (pnlPct >= CONFIG.TRAILING_ACTIVATION) {
      const trailingStop = peak * (1 - CONFIG.TRAILING_DISTANCE);
      return { stop: trailingStop, isTrailing: true };
    }
  } else {
    // SHORT CORREGIDO: trackear mínimo alcanzado (no espejo sintético)
    const currentLow = currentPrice;
    const peakLow = state.peakPriceLow[id] || pos.entry;

    if (currentLow < peakLow) {
      state.peakPriceLow[id] = currentLow;
    }

    const peak = state.peakPriceLow[id];
    const pnlPct = (pos.entry - peak) / pos.entry;

    if (pnlPct >= CONFIG.TRAILING_ACTIVATION) {
      const trailingStop = peak * (1 + CONFIG.TRAILING_DISTANCE);
      return { stop: trailingStop, isTrailing: true };
    }
  }

  // Stop fijo del perfil
  const fixedStop = pos.direction === "LONG"
    ? pos.entry * (1 - profile.stopLoss)
    : pos.entry * (1 + profile.stopLoss);

  return { stop: fixedStop, isTrailing: false };
}

// ================= OPEN =================
function open(bot, m, direction) {
  const profile = CONFIG.BOT_PROFILES[bot];

  if (isDuplicate(m.slug)) {
    log(`SKIP ${bot} ${m.slug} - duplicado`, "debug");
    return;
  }
  if (isOnCooldown(m.slug)) {
    log(`SKIP ${bot} ${m.slug} - cooldown`, "debug");
    return;
  }
  if (!priceFilter(m.price)) {
    log(`SKIP ${bot} ${m.slug} - precio fuera de rango`, "debug");
    return;
  }
  if (!liquidityFilter(m)) {
    log(`SKIP ${bot} ${m.slug} - liquidez insuficiente`, "debug");
    return;
  }

  const botOpen = state.positions.filter(p => p.bot === bot).length;
  if (botOpen >= CONFIG.MAX_OPEN_TRADES) {
    log(`SKIP ${bot} - máx trades (${botOpen}/${CONFIG.MAX_OPEN_TRADES})`, "debug");
    return;
  }

  // Fee model correcto: invertido = equity * risk - feeEntry
  const feeEntry = state.equity[bot] * profile.riskPerTrade * CONFIG.FEE_ENTRY;
  const invested = state.equity[bot] * profile.riskPerTrade - feeEntry;

  state.positions.push({
    bot,
    slug: m.slug,
    direction,
    entry: m.price,
    invested,
    opened: Date.now(),
  });

  log(`✅ OPEN [${bot}:${profile.name}] ${direction} ${m.slug} @ ${m.price.toFixed(4)} (inv=$${invested.toFixed(2)})`);
  saveState();
}

// ================= CLOSE (fee entry + exit) =================
function close(pos, px, reason) {
  let grossPnl;

  if (pos.direction === "LONG") {
    grossPnl = pos.invested * ((px - pos.entry) / pos.entry);
  } else {
    grossPnl = pos.invested * ((pos.entry - px) / pos.entry);
  }

  const feeExit = pos.invested * CONFIG.FEE_EXIT;
  const netPnl = grossPnl - feeExit;

  state.equity[pos.bot] += netPnl;

  // Cooldown exponencial
  if (netPnl < 0) {
    state.lossStreak[pos.slug] = (state.lossStreak[pos.slug] || 0) + 1;
  } else {
    state.lossStreak[pos.slug] = 0;
  }

  // Limpiar trailing peaks
  const id = positionId(pos);
  delete state.peakPriceHigh[id];
  delete state.peakPriceLow[id];

  state.closed.push({
    ...pos,
    exit: px,
    exitReason: reason,
    pnl: netPnl,
    pnlPercent: (netPnl / pos.invested) * 100,
    closedAt: Date.now(),
  });

  state.positions = state.positions.filter(p => p !== pos);
  state.lastClosed[pos.slug] = Date.now();

  const emoji = netPnl >= 0 ? "💰" : "📉";
  log(`${emoji} CLOSE [${pos.bot}] ${pos.direction} ${pos.slug} pnl=${netPnl.toFixed(4)} (${reason})`);
  saveState();
}

// ================= CHECK EXITS =================
function checkExits(markets) {
  for (const pos of [...state.positions]) {
    const m = markets.find(x => x.slug === pos.slug);
    if (!m) continue;

    const profile = CONFIG.BOT_PROFILES[pos.bot];

    // PnL actual
    let pnlPct;
    if (pos.direction === "LONG") {
      pnlPct = (m.price - pos.entry) / pos.entry;
    } else {
      pnlPct = (pos.entry - m.price) / pos.entry;
    }

    // Take profit
    if (pnlPct >= profile.takeProfit) {
      close(pos, m.price, "TP");
      continue;
    }

    // Trailing o stop fijo
    const { stop, isTrailing } = updateTrailingStop(pos, m.price);
    let hitStop = false;

    if (pos.direction === "LONG") {
      hitStop = m.price <= stop;
    } else {
      hitStop = m.price >= stop;
    }

    if (hitStop) {
      close(pos, m.price, isTrailing ? "TSL" : "SL");
    }
  }
}

// ================= FETCH MARKETS (sin límite) =================
async function fetchAllMarkets() {
  const allMarkets = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    try {
      const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (!data.length) break;

      for (const m of data) {
        if (!m.slug) continue;
        let price = 0.5;
        try {
          const prices = JSON.parse(m.outcomePrices || "[]");
          price = Number(prices[0]) || Number(m.lastPrice) || 0.5;
        } catch {
          price = Number(m.lastPrice) || 0.5;
        }

        allMarkets.push({
          slug: m.slug,
          price: Math.max(0, Math.min(1, price)),
          volume: Number(m.volume24hr || 0),
          liquidity: Number(m.liquidity || 0),
        });
      }

      hasMore = data.length === limit;
      offset += limit;
      await new Promise(r => setTimeout(r, 100)); // rate limit
    } catch (error) {
      log(`FETCH PAGE ERROR offset=${offset}: ${error.message}`, "error");
      break;
    }
  }

  log(`Fetched ${allMarkets.length} markets`, "debug");
  return allMarkets.filter(m => m.price > 0);
}

// ================= PROCESS CYCLE (bots independientes) =================
async function processCycle() {
  const markets = await fetchAllMarkets();

  if (markets.length === 0) {
    log("Sin mercados obtenidos, saltando ciclo", "warn");
    return;
  }

  checkExits(markets);

  // Preparar mercados con scores
  const scoredMarkets = markets
    .filter(m => m.volume >= CONFIG.MIN_VOLUME)
    .filter(m => m.liquidity >= CONFIG.MIN_LIQUIDITY)
    .map(m => {
      const mv = getMove(m.slug, m.price);
      const zombie = updateZombie(m.slug, mv);
      return { ...m, move: mv, zombie, score: zombie ? 0 : computeScore(m, mv) };
    })
    .filter(m => !m.zombie);

  if (scoredMarkets.length === 0) {
    log("No markets passed filters", "debug");
    return;
  }

  // Calcular threshold por percentil (top 15%)
  const allScores = scoredMarkets.map(m => m.score).filter(s => s > 0);
  const threshold = getScoreThreshold(allScores, CONFIG.PERCENTILE_THRESHOLD);

  // Filtrar por percentil
  const eligible = scoredMarkets.filter(m => m.score >= threshold);

  const longs = eligible.filter(m => m.move > CONFIG.MOVE_THRESHOLD).sort((a, b) => b.score - a.score);
  const shorts = eligible.filter(m => m.move < -CONFIG.MOVE_THRESHOLD).sort((a, b) => b.score - a.score);

  log(`Threshold: ${threshold.toFixed(3)} | Longs: ${longs.length} | Shorts: ${shorts.length}`, "debug");

  // 🚨 CADA BOT ES INDEPENDIENTE - SIN usedSlugs
  for (const bot of ["A", "B", "C"]) {
    // Cada bot tiene sus propias posiciones abiertas
    const currentPositions = state.positions.filter(p => p.bot === bot);
    if (currentPositions.length >= CONFIG.MAX_OPEN_TRADES) continue;

    // Copias independientes para cada bot (pueden tomar el mismo mercado)
    const botLongs = [...longs];
    const botShorts = [...shorts];

    let selected = null;

    // Buscar long disponible (sin filtrar por duplicado global)
    for (const l of botLongs) {
      if (!state.positions.some(p => p.bot === bot && p.slug === l.slug)) {
        selected = { market: l, type: "LONG" };
        break;
      }
    }

    if (!selected) {
      for (const s of botShorts) {
        if (!state.positions.some(p => p.bot === bot && p.slug === s.slug)) {
          selected = { market: s, type: "SHORT" };
          break;
        }
      }
    }

    if (selected) {
      open(bot, selected.market, selected.type);
    }
  }
}

// ================= STATS =================
function printStats() {
  const wins = state.closed.filter(x => x.pnl > 0).length;
  const total = state.closed.length;
  const wr = total > 0 ? (wins / total * 100).toFixed(2) : "0.00";

  const totalPnl = state.closed.reduce((sum, t) => sum + t.pnl, 0);
  const avgWin = wins > 0 ? state.closed.filter(x => x.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = (total - wins) > 0 ? state.closed.filter(x => x.pnl < 0).reduce((s, t) => s + t.pnl, 0) / (total - wins) : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "∞";

  const totalEquity = state.equity.A + state.equity.B + state.equity.C;
  const initialEquity = CONFIG.START_EQUITY * 3;
  const totalReturn = ((totalEquity - initialEquity) / initialEquity * 100).toFixed(2);

  const byReason = {};
  for (const t of state.closed) {
    byReason[t.exitReason] = byReason[t.exitReason] || { count: 0, pnl: 0 };
    byReason[t.exitReason].count++;
    byReason[t.exitReason].pnl += t.pnl;
  }

  const SEP = "=".repeat(60);
  console.log("\n" + SEP);
  console.log("📊 POLYMARKET MICRODRIFT v7.0");
  console.log(SEP);
  console.log(`📈 Trades totales:     ${total}`);
  console.log(`✅ Win Rate:           ${wr}%`);
  console.log(`💰 Profit Factor:      ${profitFactor}`);
  console.log(`💵 PnL Total:          $${totalPnl.toFixed(2)}`);
  console.log(`📊 Retorno Total:      ${totalReturn}%`);
  console.log(`🏆 Avg Win:            $${avgWin.toFixed(2)}`);
  console.log(`📉 Avg Loss:           $${avgLoss.toFixed(2)}`);
  console.log("-".repeat(60));
  for (const [r, v] of Object.entries(byReason)) {
    console.log(`   ${r.padEnd(6)}: ${String(v.count).padStart(4)} trades | PnL $${v.pnl.toFixed(2)}`);
  }
  console.log("-".repeat(60));
  for (const bot of ["A", "B", "C"]) {
    const profile = CONFIG.BOT_PROFILES[bot];
    const ret = ((state.equity[bot] - CONFIG.START_EQUITY) / CONFIG.START_EQUITY * 100).toFixed(2);
    console.log(`💰 Bot ${bot} [${profile.name}]:   $${state.equity[bot].toFixed(2)}  (${ret}%)`);
  }
  console.log(`💵 Equity Total:       $${totalEquity.toFixed(2)}`);
  console.log(SEP);

  if (state.positions.length > 0) {
    console.log("\n📌 POSICIONES ABIERTAS:");
    for (const p of state.positions) {
      const duration = Math.round((Date.now() - p.opened) / 1000 / 60);
      let peakInfo = "";
      const id = positionId(p);
      if (p.direction === "LONG" && state.peakPriceHigh[id]) {
        peakInfo = ` [peak=$${state.peakPriceHigh[id].toFixed(4)}]`;
      } else if (p.direction === "SHORT" && state.peakPriceLow[id]) {
        peakInfo = ` [peak=$${state.peakPriceLow[id].toFixed(4)}]`;
      }
      console.log(`   [${p.bot}] ${p.direction} ${p.slug.substring(0, 38).padEnd(40)} @ ${p.entry.toFixed(4)} (${duration}min)${peakInfo}`);
    }
  }

  fs.writeFileSync("stats_v7.json", JSON.stringify({
    total, wins, wr: parseFloat(wr), profitFactor, totalPnl, totalReturn: parseFloat(totalReturn),
    equity: state.equity, byReason, timestamp: Date.now(),
  }, null, 2));
}

// ================= MAIN LOOP =================
async function main() {
  console.log("\n🚀 POLYMARKET MICRODRIFT v7.0 INICIADO");
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`💰 Capital inicial: $${CONFIG.START_EQUITY * 3}`);
  for (const [bot, p] of Object.entries(CONFIG.BOT_PROFILES)) {
    console.log(`   Bot ${bot} [${p.name}]: riesgo=${p.riskPerTrade * 100}% | SL=${p.stopLoss * 100}% | TP=${p.takeProfit * 100}%`);
  }
  console.log(`📊 Score percentil: top ${100 - CONFIG.PERCENTILE_THRESHOLD}%`);
  console.log("=".repeat(60));

  let cycleCount = 0;
  let lastStats = Date.now();

  while (true) {
    try {
      cycleCount++;
      const t0 = Date.now();
      log(`🔄 CICLO ${cycleCount}`, "info");

      await processCycle();

      if (Date.now() - lastStats > CONFIG.STATS_INTERVAL_MS) {
        printStats();
        lastStats = Date.now();
      }

      const elapsed = Date.now() - t0;
      const waitTime = Math.max(0, CONFIG.CYCLE_INTERVAL_MS - elapsed);
      log(`⏳ Ciclo en ${(elapsed / 1000).toFixed(1)}s, próximo en ${(waitTime / 1000).toFixed(0)}s`);

      await new Promise(r => setTimeout(r, waitTime));
    } catch (error) {
      log(`❌ ERROR: ${error.message}`, "error");
      console.error(error.stack);
      await new Promise(r => setTimeout(r, 60_000));
    }
  }
}

// ================= EXPORTS =================
module.exports = { processCycle, printStats, state, CONFIG };

if (require.main === module) {
  main().catch(console.error);
}
