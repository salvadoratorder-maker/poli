import fetch from "node-fetch";
import fs from "fs";

// ═════════════════════════════════════════════════════════════
//  BOT v10 + EDGE ANALYZER
//  Cada ciclo calcula automáticamente:
//  - Winrate, AvgWin, AvgLoss
//  - Expectancy (cuánto ganas por trade de media)
//  - Profit Factor (ratio ganancia/pérdida)
//  - Status: EDGE / NO_EDGE / NO_DATA
// ═════════════════════════════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL:      200,
  RISK_PER_TRADE:       0.02,
  MAX_SIZE_PCT:         0.05,
  MAX_OPEN_TRADES:      3,

  MIN_VOLUME_24H:       100000, // bajado de 300K — más candidatos
  PRICE_MIN:            0.30,
  PRICE_MAX:            0.70,
  MIN_LIQUIDITY:        30000,  // bajado de 75K — más candidatos
  MIN_HOURS_TO_RESOLVE: 48,

  MIN_SCORE:            0.22,
  MIN_ENTRY_MOVE:       0.005,

  VOLUME_SPIKE:         1.5,
  MOMENTUM:             0.015,

  STOP_LOSS:            0.07,
  TAKE_PROFIT:          0.10,
  TRAILING:             0.04,

  MAX_DD:               0.25,
  MAX_HOLD_DAYS:        5,
  FEES:                 0.005,
  INTERVAL:             60 * 60 * 1000,
};

// ═════════════════════════════════════════════════════════════
//  ESTADO
// ═════════════════════════════════════════════════════════════
let capital      = CONFIG.INITIAL_CAPITAL;
let peakEquity   = CONFIG.INITIAL_CAPITAL;
let openTrades   = [];
let closedTrades = [];
let marketMemory = {};
let priceHistory = {};
let paused       = false;
let cycle        = 0;

// ═════════════════════════════════════════════════════════════
//  PERSISTENCE
// ═════════════════════════════════════════════════════════════
function loadState() {
  try {
    const s      = JSON.parse(fs.readFileSync("state.json"));
    capital      = s.capital      ?? CONFIG.INITIAL_CAPITAL;
    peakEquity   = s.peakEquity   ?? CONFIG.INITIAL_CAPITAL;
    openTrades   = s.openTrades   ?? [];
    closedTrades = s.closedTrades ?? [];
    marketMemory = s.marketMemory ?? {};
    priceHistory = s.priceHistory ?? {};
    paused       = s.paused       ?? false;
    log(`[LOAD] Capital: $${capital.toFixed(2)} | Trades: ${openTrades.length} | Cerrados: ${closedTrades.length}`);
  } catch {
    log("⚠ Sin estado previo — empezando de cero");
  }
}

function saveState() {
  fs.writeFileSync("state.json", JSON.stringify({
    capital, peakEquity, openTrades, closedTrades,
    marketMemory, priceHistory, paused,
  }, null, 2));
}

// ═════════════════════════════════════════════════════════════
//  UTILS
// ═════════════════════════════════════════════════════════════
const ts  = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (msg) => console.log(`[${ts()}] ${msg}`);

function equity(markets) {
  let eq = capital;
  for (const t of openTrades) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) eq += t.size * (m.price / t.entry) - t.size;
  }
  return eq;
}

// ═════════════════════════════════════════════════════════════
//  EDGE ANALYZER — tu función integrada
//  Se ejecuta cada ciclo cuando hay 5+ trades cerrados
//  Dice exactamente si el sistema tiene edge real o no
// ═════════════════════════════════════════════════════════════
function analyzeBot() {
  const trades = closedTrades;

  if (trades.length < 5) {
    return { status: "NO_DATA", message: `Solo ${trades.length}/5 trades cerrados` };
  }

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winrate = wins.length / trades.length;

  const avgWin = wins.length > 0
    ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length)
    : 0;

  // Expectancy: cuánto ganas de media por cada trade
  // Si es positivo → el sistema es matemáticamente rentable a largo plazo
  const expectancy = (winrate * avgWin) - ((1 - winrate) * avgLoss);

  // Profit Factor: ratio entre lo que ganas y lo que pierdes
  // > 1.0 = rentable | > 1.5 = bueno | > 2.0 = muy bueno
  const profitFactor = avgLoss > 0
    ? (winrate * avgWin) / ((1 - winrate) * avgLoss)
    : 0;

  // Breakeven winrate: mínimo WR necesario para ser rentable con este TP/SL
  const breakevenWR = avgLoss > 0
    ? avgLoss / (avgWin + avgLoss)
    : 0.5;

  return {
    trades:       trades.length,
    winrate:      winrate,
    avgWin:       avgWin,
    avgLoss:      avgLoss,
    expectancy:   expectancy,
    profitFactor: profitFactor,
    breakevenWR:  breakevenWR,
    status:       expectancy > 0 ? "EDGE" : "NO_EDGE",
  };
}

function printEdge(analysis) {
  if (analysis.status === "NO_DATA") {
    log(`🔬 EDGE: ${analysis.message} — necesito más datos`);
    return;
  }

  const statusIcon = analysis.status === "EDGE" ? "✅" : "❌";
  const pfIcon     = analysis.profitFactor >= 1.5 ? "🟢" :
                     analysis.profitFactor >= 1.0 ? "🟡" : "🔴";

  log(`🔬 EDGE ANALYSIS (${analysis.trades} trades):`);
  log(`   ${statusIcon} Status: ${analysis.status} | Expectancy: ${analysis.expectancy>=0?"+":""}$${analysis.expectancy.toFixed(3)}/trade`);
  log(`   WR: ${(analysis.winrate*100).toFixed(1)}% (mín necesario: ${(analysis.breakevenWR*100).toFixed(1)}%)`);
  log(`   AvgWin: +$${analysis.avgWin.toFixed(2)} | AvgLoss: -$${analysis.avgLoss.toFixed(2)}`);
  log(`   ${pfIcon} Profit Factor: ${analysis.profitFactor.toFixed(2)} (>1.5 = bueno, >2.0 = muy bueno)`);

  // Consejo automático según el análisis
  if (analysis.status === "NO_EDGE") {
    if (analysis.winrate < analysis.breakevenWR) {
      log(`   💡 WR demasiado bajo — el sistema acierta menos de lo necesario`);
    }
    if (analysis.avgWin < analysis.avgLoss * 0.8) {
      log(`   💡 AvgWin < AvgLoss — ganas poco cuando aciertas pero pierdes mucho cuando fallas`);
    }
  }

  if (analysis.status === "EDGE") {
    if (analysis.profitFactor < 1.3) {
      log(`   💡 Edge pequeño — funciona pero necesita más trades para confirmarlo`);
    } else {
      log(`   💡 Edge sólido — el sistema está funcionando correctamente`);
    }
  }
}

function printStats() {
  const wins   = closedTrades.filter(t => t.pnl > 0).length;
  const losses = closedTrades.filter(t => t.pnl <= 0).length;
  const total  = closedTrades.length;
  const wr     = total > 0 ? ((wins/total)*100).toFixed(0)+"%" : "—";
  const pnl    = capital - CONFIG.INITIAL_CAPITAL;
  const avgW   = wins   > 0 ? (closedTrades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/wins).toFixed(2) : "—";
  const avgL   = losses > 0 ? (closedTrades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0)/losses).toFixed(2) : "—";
  log(`💰 Capital: $${capital.toFixed(2)} | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(2)} | WR: ${wr} (${wins}W/${losses}L) | AvgW: +$${avgW} | AvgL: $${avgL}`);
}

// ═════════════════════════════════════════════════════════════
//  API
// ═════════════════════════════════════════════════════════════
async function getMarkets() {
  try {
    const res  = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30"
    );
    if (!res.ok) throw new Error("API " + res.status);
    const data = await res.json();

    return data.map(m => {
      let price = 0;
      try {
        const raw    = JSON.parse(m.outcomePrices || "[0]");
        const prices = raw.map(p => parseFloat(p)).filter(p => !isNaN(p) && p > 0);
        price = prices.length > 0
          ? prices.reduce((a, b) => Math.abs(b-0.5) < Math.abs(a-0.5) ? b : a, prices[0])
          : 0;
      } catch { price = parseFloat(m.lastPrice) || 0; }

      return {
        slug:      m.slug || m.id,
        question:  (m.question || "").slice(0, 65),
        price,
        volume24h: parseFloat(m.volume24hr) || 0,
        liquidity: parseFloat(m.liquidity)  || 0,
        endDate:   m.endDate || null,
      };
    }).filter(m => m.price > 0 && m.slug);

  } catch (e) {
    log("❌ API error: " + e.message);
    return [];
  }
}

// ═════════════════════════════════════════════════════════════
//  FILTROS
// ═════════════════════════════════════════════════════════════
function isValid(m) {
  if (m.price < CONFIG.PRICE_MIN || m.price > CONFIG.PRICE_MAX) return false;
  if (m.volume24h < CONFIG.MIN_VOLUME_24H)  return false;
  if (m.liquidity < CONFIG.MIN_LIQUIDITY)   return false;
  if (openTrades.find(t => t.slug === m.slug)) return false;

  if (m.endDate) {
    const hoursLeft = (new Date(m.endDate) - Date.now()) / 3600000;
    if (hoursLeft < CONFIG.MIN_HOURS_TO_RESOLVE) return false;
  }

  const s = (m.slug     || "").toLowerCase();
  const q = (m.question || "").toLowerCase();
  const liveKw = ["vs.","vs ","spread:","over/under","game ","bo3","bo5","map ","lck","lec","lcs"," g1 "," g2 "," g3 "];
  if (liveKw.some(k => s.includes(k) || q.includes(k))) return false;

  return true;
}

// ═════════════════════════════════════════════════════════════
//  VOLATILIDAD
// ═════════════════════════════════════════════════════════════
function calcVolatility(slug) {
  const h = priceHistory[slug] || [];
  if (h.length < 2) return 0.01;
  const moves = [];
  for (let i = 1; i < h.length; i++) {
    const p = h[i-1].price;
    if (p > 0) moves.push(Math.abs((h[i].price - p) / p));
  }
  return moves.length > 0 ? moves.reduce((a,b) => a+b, 0) / moves.length : 0.01;
}

// ═════════════════════════════════════════════════════════════
//  PATRÓN — solo LONG
// ═════════════════════════════════════════════════════════════
function detectPattern(m) {
  const h = priceHistory[m.slug] || [];
  if (h.length < 2) return { type: "NONE" };

  const prices = [...h.map(x => x.price), m.price];
  const moves  = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0) moves.push((prices[i] - prices[i-1]) / prices[i-1]);
  }
  if (moves.length === 0) return { type: "NONE" };

  const last  = moves[moves.length - 1];
  const prev  = moves.length > 1 ? moves[moves.length - 2] : 0;
  const total = prices[0] > 0 ? (prices[prices.length-1] - prices[0]) / prices[0] : 0;

  if (last > 0 && total > CONFIG.MOMENTUM)               return { type: "CONT"  };
  if (prev < -CONFIG.MOMENTUM && last > CONFIG.MOMENTUM)  return { type: "REV"   };
  if (prev > 0 && last < 0 && last > -0.03)               return { type: "PULL"  };
  return { type: "NONE" };
}

// ═════════════════════════════════════════════════════════════
//  SCORE
// ═════════════════════════════════════════════════════════════
function calcScore(m) {
  const prev    = marketMemory[m.slug];
  const history = priceHistory[m.slug] || [];

  if (!prev) {
    return { score: m.volume24h > CONFIG.MIN_VOLUME_24H * 3 ? 0.20 : 0, pattern: { type: "NONE" }, move: 0 };
  }

  const move     = prev.price > 0 ? (m.price - prev.price) / prev.price : 0;
  const volRatio = prev.volume24h > 0 ? m.volume24h / prev.volume24h : 1;
  const pattern  = detectPattern(m);
  let   score    = 0;

  if (move < -0.01)              score -= 0.20;
  if (volRatio > CONFIG.VOLUME_SPIKE) score += Math.min(0.30, 0.30 * (volRatio-1) / 2);
  if (pattern.type === "PULL")   score += 0.40;
  if (pattern.type === "REV")    score += 0.35;
  if (pattern.type === "CONT")   score += 0.25;
  score += Math.min(0.20, Math.abs(move) * 5);

  if (prev.liquidity > 0) {
    const liqDrop = (prev.liquidity - m.liquidity) / prev.liquidity;
    if (liqDrop > 0.03 && m.volume24h > prev.volume24h) score += Math.min(0.15, liqDrop * 2);
  }

  if (move > 0.05) score -= 0.15;

  if (history.length >= 3 && history[0].price > 0) {
    const totalMove = (m.price - history[0].price) / history[0].price;
    if (totalMove > 0.10) score -= 0.20;
  }

  if (prev.volume24h > 0 && m.volume24h < prev.volume24h * 0.85 && Math.abs(move) < 0.005) {
    score -= 0.10;
  }

  return { score: Math.max(0, Math.min(1, score)), pattern, move };
}

// ═════════════════════════════════════════════════════════════
//  POSITION SIZE
// ═════════════════════════════════════════════════════════════
function calcSize(price, sl) {
  const risk     = capital * CONFIG.RISK_PER_TRADE;
  const stopDist = price   * sl;
  let   size     = stopDist > 0 ? risk / stopDist : risk;
  size = Math.min(size, capital * CONFIG.MAX_SIZE_PCT);
  return Math.max(1, parseFloat(size.toFixed(2)));
}

// ═════════════════════════════════════════════════════════════
//  TRADES
// ═════════════════════════════════════════════════════════════
function openTrade(m, data) {
  const vol     = calcVolatility(m.slug);
  const sl      = Math.min(0.12, Math.max(CONFIG.STOP_LOSS,   vol * 1.2));
  const tp      = Math.min(0.20, Math.max(CONFIG.TAKE_PROFIT, vol * 2.0));
  const tr      = Math.min(0.07, Math.max(CONFIG.TRAILING,    vol * 0.8));
  const tpFinal = data.pattern.type === "PULL" ? tp * 1.2 : tp;
  const size    = calcSize(m.price, sl);

  if (capital < size) { log(`⚠ Capital insuficiente`); return; }

  capital -= size;

  openTrades.push({
    slug: m.slug, question: m.question, entry: m.price,
    size, sl, tp: tpFinal, trailing: tr,
    peak: m.price, partial: false, openDate: ts(),
    pattern: data.pattern.type, score: data.score,
  });

  log(`🟢 OPEN [${data.pattern.type}] ${m.question.substring(0,50)}`);
  log(`   @${m.price.toFixed(3)} | $${size.toFixed(2)} | SL:${(sl*100).toFixed(1)}% TP:${(tpFinal*100).toFixed(1)}% | Score:${(data.score*100).toFixed(0)}/100`);
}

function closeTrade(t, price, reason) {
  const gross = t.size * (price / t.entry);
  const fee   = gross  * CONFIG.FEES;
  const net   = gross  - fee;
  const pnl   = net    - t.size;

  capital += net;
  closedTrades.push({ ...t, exitPrice: price, pnl, reason, closeDate: ts() });
  openTrades = openTrades.filter(x => x !== t);

  log(`${pnl>=0?"💰":"🛑"} CLOSE (${reason}): ${t.question.substring(0,45)}`);
  log(`   @${t.entry.toFixed(3)}→@${price.toFixed(3)} | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(2)} | Patrón: ${t.pattern}`);
}

function manage(t, price) {
  const move = (price - t.entry) / t.entry;
  const days = (Date.now() - new Date(t.openDate)) / 86400000;
  const sl   = t.sl      || CONFIG.STOP_LOSS;
  const tp   = t.tp      || CONFIG.TAKE_PROFIT;
  const tr   = t.trailing || CONFIG.TRAILING;

  if (days > CONFIG.MAX_HOLD_DAYS)   { closeTrade(t, price, `TIMEOUT_${days.toFixed(1)}d`); return; }
  if (move <= -sl)                   { closeTrade(t, price, "SL"); return; }

  if (move >= tp && !t.partial) {
    const half  = t.size * 0.5;
    const value = half   * (price / t.entry);
    const fee   = value  * CONFIG.FEES;
    capital    += value  - fee;
    t.size     -= half;
    t.partial   = true;
    t.peak      = price;
    log(`✂️  PARTIAL @${price.toFixed(3)} | +$${(value-fee-half).toFixed(2)}`);
    return;
  }

  if (t.partial) {
    if (price > t.peak) t.peak = price;
    if ((t.peak - price) / t.peak >= tr) closeTrade(t, price, "TRAIL");
  }
}

// ═════════════════════════════════════════════════════════════
//  CICLO PRINCIPAL
// ═════════════════════════════════════════════════════════════
async function run() {
  cycle++;
  log(`\n════ CICLO ${cycle} ${paused?"[PAUSADO]":""} ════`);

  const markets = await getMarkets();
  if (!markets.length) {
    log("⚠ Sin mercados");
    return setTimeout(run, CONFIG.INTERVAL);
  }

  const prevMemory = { ...marketMemory };

  // 1. Gestionar trades abiertos
  for (const t of [...openTrades]) {
    const m = markets.find(x => x.slug === t.slug);
    if (m) manage(t, m.price);
  }

  // 2. Buscar entradas
  if (!paused && openTrades.length < CONFIG.MAX_OPEN_TRADES) {
    const candidates = markets
      .filter(m => isValid(m))
      .filter(m => {
        const prev = prevMemory[m.slug];
        if (!prev) return true;
        const move = (m.price - prev.price) / prev.price;
        return move >= CONFIG.MIN_ENTRY_MOVE;
      })
      .map(m => ({ m, data: calcScore(m) }))
      .filter(x => x.data.score >= CONFIG.MIN_SCORE)
      .sort((a, b) => b.data.score - a.data.score);

    let opened = 0;
    for (const c of candidates) {
      if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
      log(`✅ [${c.data.pattern.type}] Score:${(c.data.score*100).toFixed(0)}/100 ${c.m.question.substring(0,50)}`);
      openTrade(c.m, c.data);
      opened++;
    }

    if (opened === 0) {
      const v = markets.filter(m => isValid(m)).length;
      const mv = markets.filter(m => {
        if (!isValid(m)) return false;
        const prev = prevMemory[m.slug];
        if (!prev) return true;
        return (m.price - prev.price) / prev.price >= CONFIG.MIN_ENTRY_MOVE;
      }).length;
      log(`ℹ Sin señales | Válidos: ${v}/30 | Con movimiento: ${mv} | Con score≥${CONFIG.MIN_SCORE*100}%: ${candidates.length}`);
    }
  }

  // 3. Actualizar memoria
  markets.forEach(m => {
    const prev = marketMemory[m.slug] || {};
    marketMemory[m.slug] = {
      price:     m.price,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
      prevMove:  prev.price > 0 ? (m.price - prev.price) / prev.price : 0,
    };
    if (!priceHistory[m.slug]) priceHistory[m.slug] = [];
    priceHistory[m.slug].push({ price: m.price, volume24h: m.volume24h });
    if (priceHistory[m.slug].length > 6) priceHistory[m.slug].shift();
  });

  // 4. Equity y drawdown
  const eq = equity(markets);
  if (eq > peakEquity) peakEquity = eq;
  const dd = (peakEquity - eq) / peakEquity;
  log(`📊 Equity: $${eq.toFixed(2)} | DD: ${(dd*100).toFixed(1)}%`);
  printStats();

  // 5. EDGE ANALYZER — se ejecuta automáticamente cada ciclo
  const analysis = analyzeBot();
  printEdge(analysis);

  // 6. Circuit breaker
  if (dd > CONFIG.MAX_DD && !paused) {
    log(`⚠️  MAX DD (${(dd*100).toFixed(1)}%) — pausando entradas`);
    paused = true;
  }
  if (paused && dd < CONFIG.MAX_DD * 0.5) {
    log(`✅ DD recuperado — reanudando`);
    paused = false;
  }

  // 7. Auto-ajuste basado en edge (después de 10+ trades)
  if (analysis.status === "NO_EDGE" && closedTrades.length >= 10) {
    log(`⚙️  Auto-ajuste: sin edge en ${closedTrades.length} trades`);
    if (analysis.winrate < analysis.breakevenWR) {
      CONFIG.MIN_SCORE      = Math.min(0.45, CONFIG.MIN_SCORE + 0.03);
      CONFIG.MIN_ENTRY_MOVE = Math.min(0.02, CONFIG.MIN_ENTRY_MOVE + 0.002);
      log(`   Filtros más estrictos: Score≥${(CONFIG.MIN_SCORE*100).toFixed(0)}% Mov≥${(CONFIG.MIN_ENTRY_MOVE*100).toFixed(1)}%`);
    }
    if (analysis.avgWin < analysis.avgLoss * 0.9) {
      CONFIG.TAKE_PROFIT = Math.min(0.18, CONFIG.TAKE_PROFIT + 0.01);
      CONFIG.STOP_LOSS   = Math.max(0.05, CONFIG.STOP_LOSS   - 0.005);
      log(`   Ratio mejorado: TP=${(CONFIG.TAKE_PROFIT*100).toFixed(0)}% SL=${(CONFIG.STOP_LOSS*100).toFixed(0)}%`);
    }
  }

  saveState();
  setTimeout(run, CONFIG.INTERVAL);
}

// ═════════════════════════════════════════════════════════════
//  START
// ═════════════════════════════════════════════════════════════
loadState();
log(`🚀 BOT v10 + EDGE ANALYZER | Capital: $${capital.toFixed(2)}`);
log(`   Precio: ${CONFIG.PRICE_MIN}-${CONFIG.PRICE_MAX} | Liq: $${CONFIG.MIN_LIQUIDITY/1e3}K | Res: ${CONFIG.MIN_HOURS_TO_RESOLVE}h`);
log(`   Score: ${CONFIG.MIN_SCORE*100}% | Mov: ${CONFIG.MIN_ENTRY_MOVE*100}% | TP:${CONFIG.TAKE_PROFIT*100}% SL:${CONFIG.STOP_LOSS*100}%`);
run();
