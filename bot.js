import fetch from "node-fetch";
import fs from "fs";

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.025,
  MAX_SIZE_PCT: 0.06,
  MAX_OPEN_TRADES: 4,

  MIN_VOLUME_24H: 300000,
  PRICE_MIN: 0.25,
  PRICE_MAX: 0.75,
  MIN_LIQUIDITY: 100000,

  MIN_SCORE: 0.30,

  MAX_DD: 0.30,
  MAX_HOLD_DAYS: 5,
  FEES: 0.005,
  INTERVAL: 60 * 60 * 1000,
};

let capital = CONFIG.INITIAL_CAPITAL;
let openTrades = [];
let closedTrades = [];
let marketMemory = {};
let priceHistory = {};
let paused = false;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ═════════════════════════════════════════════════════════════
// VOLATILIDAD
// ═════════════════════════════════════════════════════════════
function calcVolatility(slug) {
  const h = priceHistory[slug] || [];
  if (h.length < 2) return 0.01;

  let moves = [];
  for (let i = 1; i < h.length; i++) {
    moves.push(Math.abs((h[i].price - h[i-1].price) / h[i-1].price));
  }
  return moves.reduce((a,b)=>a+b,0)/moves.length;
}

// ═════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════
async function getMarkets() {
  const res = await fetch("https://gamma-api.polymarket.com/markets?active=true&limit=30");
  const data = await res.json();

  return data.map(m => {
    let prices = JSON.parse(m.outcomePrices || "[0]");
    prices = prices.map(p=>parseFloat(p)).filter(p=>p>0);

    let price = prices.reduce((a,b)=>
      Math.abs(b-0.5)<Math.abs(a-0.5)?b:a, prices[0]||0
    );

    return {
      slug: m.slug,
      question: m.question,
      price,
      volume24h: parseFloat(m.volume24hr)||0,
      liquidity: parseFloat(m.liquidity)||0
    };
  }).filter(m=>m.price>0);
}

// ═════════════════════════════════════════════════════════════
// PATTERN
// ═════════════════════════════════════════════════════════════
function detectPattern(m) {
  const h = priceHistory[m.slug] || [];
  if (h.length < 2) return { type: "NONE", dir: 0 };

  const p = [...h.map(x=>x.price), m.price];
  const moves = [];

  for (let i=1;i<p.length;i++){
    moves.push((p[i]-p[i-1])/p[i-1]);
  }

  const last = moves.at(-1);
  const prev = moves.at(-2) || 0;
  const total = (p.at(-1)-p[0])/p[0];

  // CONTINUATION
  if (last > 0 && total > 0.02) return { type:"CONT", dir:1 };
  if (last < 0 && total < -0.02) return { type:"CONT", dir:-1 };

  // REVERSAL
  if (prev < -0.02 && last > 0.02) return { type:"REV", dir:1 };
  if (prev > 0.02 && last < -0.02) return { type:"REV", dir:-1 };

  // PULLBACK
  if (prev > 0 && last < 0) return { type:"PULL", dir:1 };
  if (prev < 0 && last > 0) return { type:"PULL", dir:-1 };

  return { type:"NONE", dir:0 };
}

// ═════════════════════════════════════════════════════════════
// SCORE
// ═════════════════════════════════════════════════════════════
function calcScore(m) {
  const prev = marketMemory[m.slug];
  if (!prev) return { score:0 };

  const move = (m.price - prev.price)/prev.price;
  const volRatio = m.volume24h / prev.volume24h;
  const pattern = detectPattern(m);

  let score = 0;

  // volumen
  if (volRatio > 1.5) score += 0.3;

  // patrón
  if (pattern.type === "PULL") score += 0.4;
  if (pattern.type === "REV")  score += 0.35;
  if (pattern.type === "CONT") score += 0.3;

  // dirección
  score += Math.min(0.3, Math.abs(move)*5);

  // aceleración (anti FOMO)
  const accel = move - ((prev.prevMove)||0);
  if (accel > 0.03) score -= 0.2;

  return { score, pattern, move };
}

// ═════════════════════════════════════════════════════════════
// SIZE
// ═════════════════════════════════════════════════════════════
function calcSize(price, sl) {
  const risk = capital * CONFIG.RISK_PER_TRADE;
  let size = risk / (price * sl);
  return Math.min(size, capital * CONFIG.MAX_SIZE_PCT);
}

// ═════════════════════════════════════════════════════════════
// OPEN
// ═════════════════════════════════════════════════════════════
function openTrade(m, data) {
  const vol = calcVolatility(m.slug);

  let sl = Math.max(0.05, vol);
  let tp = sl * 1.6;

  // patrón modifica
  if (data.pattern.type === "PULL") tp *= 1.2;
  if (data.pattern.type === "CONT") tp *= 0.8;

  const size = calcSize(m.price, sl);

  capital -= size;

  openTrades.push({
    slug: m.slug,
    entry: m.price,
    size,
    dir: data.pattern.dir,
    sl,
    tp,
    peak: m.price
  });

  log(`OPEN ${data.pattern.type} ${data.pattern.dir>0?"LONG":"SHORT"} @${m.price}`);
}

// ═════════════════════════════════════════════════════════════
// MANAGE
// ═════════════════════════════════════════════════════════════
function manage(t, price) {
  const move = (price - t.entry)/t.entry * t.dir;

  if (move <= -t.sl) return closeTrade(t, price, "SL");
  if (move >= t.tp) return closeTrade(t, price, "TP");

  if (price > t.peak) t.peak = price;

  if ((t.peak - price)/t.peak > 0.05) {
    return closeTrade(t, price, "TRAIL");
  }
}

// ═════════════════════════════════════════════════════════════
// CLOSE
// ═════════════════════════════════════════════════════════════
function closeTrade(t, price, r) {
  const result = t.size * (price/t.entry);
  capital += result;

  openTrades = openTrades.filter(x=>x!==t);

  log(`CLOSE ${r} PnL=${(result-t.size).toFixed(2)}`);
}

// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════
async function run() {
  const markets = await getMarkets();

  // gestionar
  for (const t of [...openTrades]) {
    const m = markets.find(x=>x.slug===t.slug);
    if (m) manage(t, m.price);
  }

  // candidatos
  let candidates = markets.map(m=>{
    const data = calcScore(m);
    return { m, data };
  });

  candidates = candidates
    .filter(x=>x.data.score >= CONFIG.MIN_SCORE)
    .sort((a,b)=>b.data.score - a.data.score)
    .slice(0, CONFIG.MAX_OPEN_TRADES);

  for (const c of candidates) {
    if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) break;
    openTrade(c.m, c.data);
  }

  // guardar memoria
  markets.forEach(m=>{
    const prev = marketMemory[m.slug] || {};
    const move = prev.price ? (m.price-prev.price)/prev.price : 0;

    marketMemory[m.slug] = {
      price: m.price,
      volume24h: m.volume24h,
      prevMove: move
    };

    if (!priceHistory[m.slug]) priceHistory[m.slug]=[];
    priceHistory[m.slug].push({price:m.price});
    if (priceHistory[m.slug].length>6) priceHistory[m.slug].shift();
  });

  log(`Capital: ${capital.toFixed(2)}`);
  setTimeout(run, CONFIG.INTERVAL);
}

run();
