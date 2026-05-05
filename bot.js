function analyzeBot(bot) {
  const trades = bot.closedTrades;
  if (trades.length < 5) {
    return { status: "NO_DATA" };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winrate = wins.length / trades.length;

  const avgWin = wins.length > 0
    ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length)
    : 0;

  const expectancy = (winrate * avgWin) - ((1 - winrate) * avgLoss);

  const profitFactor = avgLoss > 0
    ? (winrate * avgWin) / ((1 - winrate) * avgLoss)
    : 0;

  return {
    trades: trades.length,
    winrate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    status: expectancy > 0 ? "EDGE" : "NO_EDGE",
  };
}
