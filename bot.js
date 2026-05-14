// ==========================================
// POLYMARKET MICRODRIFT v4
// REAL FIXED
// ==========================================

import fs from "fs";

const CONFIG = {
  API: "https://gamma-api.polymarket.com",

  PRICE_MIN: 0.18,
  PRICE_MAX: 0.82,
  MIN_VOLUME: 50000,

  RISK_PER_TRADE: 0.02,
  MAX_OPEN_PER_BOT: 2,

  MAX_POSITIONS_PER_MARKET_PER_BOT: 1,

  CYCLE_INTERVAL: 5 * 60 * 1000,
  HOLD_TIME: 60 * 60 * 1000,

  MEMORY_FILE: "./memory.json",
  STATE_FILE: "./state.json",

  BOTS: {
    A: { MIN_SCORE: 0.10 },
    B: { MIN_SCORE: 0.14 },
    C: { MIN_SCORE: 0.18 }
  }
};

// ==========================================
// STATE
// ==========================================

let state = {
  cycle: 0,

  equity: {
    A: 200,
    B: 200,
    C: 200
  },

  positions: [],
  memory: {},
  closed: []
};

// ==========================================
// UTILS
// ==========================================

const ts = () => new Date().toISOString();

function log(m) {
  console.log(`[${ts()}] ${m}`);
}

function save() {
  fs.writeFileSync(
    CONFIG.STATE_FILE,
    JSON.stringify(state, null, 2)
  );
}

function load() {
  try {
    state = JSON.parse(
      fs.readFileSync(CONFIG.STATE_FILE)
    );
    log("STATE LOADED");
  } catch {
    log("NEW STATE");
  }
}

// ==========================================
// PRICE EXTRACTION FIX
// ==========================================

function extractPrice(m) {
  try {
    const raw = JSON.parse(m.outcomePrices || "[]");

    const prices = raw
      .map(Number)
      .filter(p => p > 0 && p < 1);

    if (prices.length) return prices[0];
  } catch {}

  return Number(m.lastPrice || 0.5);
}

// ==========================================
// FETCH
// ==========================================

async function fetchMarkets() {
  const r = await fetch(
    `${CONFIG.API}/markets?active=true&closed=false&limit=100`
  );

  if (!r.ok) throw new Error(r.status);

  const d = await r.json();

  return d.map(m => ({
    slug: m.slug,
    name: m.question,
    price: extractPrice(m),
    volume: Number(m.volume24hr || 0)
  }));
}

// ==========================================
// MEMORY PERSISTENT
// ==========================================

function updateMemory(markets) {
  for (const m of markets) {
    if (!state.memory[m.slug])
      state.memory[m.slug] = [];

    state.memory[m.slug].push({
      p: m.price,
      t: Date.now()
    });

    if (state.memory[m.slug].length > 24)
      state.memory[m.slug].shift();
  }
}

function move(slug) {
  const h = state.memory[slug];
  if (!h || h.length < 2) return 0;

  const now = h[h.length - 1].p;

  // 30m drift aprox
  const prev = h[Math.max(0, h.length - 6)].p;

  return now - prev;
}

// ==========================================
// FILTER
// ==========================================

function filter(markets) {
  return markets.filter(
    m =>
      m.price > CONFIG.PRICE_MIN &&
      m.price < CONFIG.PRICE_MAX &&
      m.volume >= CONFIG.MIN_VOLUME
  );
}

// ==========================================
// SCORE FIX
// ==========================================

function score(m) {
  const mv = move(m.slug);
  const vol = m.volume / 100000;
  const dist = Math.abs(m.price - 0.5);

  let s = 0;

  if (mv > 0.0005) s += 0.30;
  if (vol > 0.8) s += 0.20;
  if (mv > 0) s += 0.15;
  if (dist > 0.28) s -= 0.10;
  if (mv > 0.12) s -= 0.10;

  return Math.max(0, Math.min(1, s));
}

// ==========================================
// DUPLICATE PER BOT FIX
// ==========================================

function duplicate(bot, slug) {
  return state.positions.some(
    p => p.bot === bot && p.slug === slug
  );
}

// ==========================================
// OPEN
// ==========================================

function open(bot, m) {
  if (duplicate(bot, m.slug)) return;

  const size =
    state.equity[bot] *
    CONFIG.RISK_PER_TRADE;

  state.positions.push({
    bot,
    slug: m.slug,
    name: m.name,
    entry: m.price,
    size,
    opened: Date.now()
  });

  log(
    `OPEN ${bot} ${m.name.slice(0, 30)} p=${m.price.toFixed(
      3
    )} s=${score(m).toFixed(2)}`
  );
}

// ==========================================
// CLOSE
// ==========================================

function close(pos, px) {
  const pnl =
    pos.size *
    ((px - pos.entry) / pos.entry);

  state.equity[pos.bot] += pnl;

  state.closed.push({
    ...pos,
    exit: px,
    pnl
  });

  state.positions =
    state.positions.filter(p => p !== pos);

  log(
    `CLOSE ${pos.bot} pnl=${pnl.toFixed(
      2
    )} eq=${state.equity[pos.bot].toFixed(2)}`
  );
}

// ==========================================
// MANAGE
// ==========================================

function manage(markets) {
  const now = Date.now();

  for (const p of [...state.positions]) {
    const m = markets.find(
      x => x.slug === p.slug
    );

    if (!m) continue;

    if (
      now - p.opened >
      CONFIG.HOLD_TIME
    ) {
      close(p, m.price);
    }
  }
}

// ==========================================
// TRADE
// ==========================================

function trade(markets) {
  for (const bot of ["A", "B", "C"]) {
    const openCount =
      state.positions.filter(
        p => p.bot === bot
      ).length;

    if (
      openCount >=
      CONFIG.MAX_OPEN_PER_BOT
    )
      continue;

    const best = markets
      .map(m => ({
        ...m,
        s: score(m)
      }))
      .filter(
        m =>
          m.s >=
          CONFIG.BOTS[bot].MIN_SCORE
      )
      .sort((a, b) => b.s - a.s)[0];

    if (best) open(bot, best);
  }
}

// ==========================================
// REPORT
// ==========================================

function report(markets) {
  log(
    `CYCLE ${state.cycle} mkts=${markets.length} open=${state.positions.length}`
  );

  for (const b of ["A", "B", "C"]) {
    log(
      `${b} eq=${state.equity[
        b
      ].toFixed(2)} open=${
        state.positions.filter(
          p => p.bot === b
        ).length
      }`
    );
  }
}

// ==========================================
// LOOP
// ==========================================

async function cycle() {
  state.cycle++;

  try {
    const mkts =
      await fetchMarkets();

    updateMemory(mkts);

    const f = filter(mkts);

    manage(f);

    trade(f);

    report(f);

    save();
  } catch (e) {
    log(`ERR ${e.message}`);
  }

  setTimeout(
    cycle,
    CONFIG.CYCLE_INTERVAL
  );
}

// ==========================================
// START
// ==========================================

load();

log("🚀 MICRODRIFT v4 LIVE");

cycle();
