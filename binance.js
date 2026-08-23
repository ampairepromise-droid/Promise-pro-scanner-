const BASE = 'https://fapi.binance.com';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchKlines(symbol, interval, limit) {
  const raw = await fetchJson(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(c => ({ time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) }));
}

async function fetchCurrentPrice(symbol) {
  const data = await fetchJson(`${BASE}/fapi/v1/ticker/price?symbol=${symbol}`);
  return parseFloat(data.price);
}

// Returns the top `limit` USDT perpetuals by 24h quote volume, filtered to the
// same >= $2M liquidity floor the live scanner uses.
async function fetchTopVolumeUniverse(limit, minVolumeUsd) {
  const [exchangeInfo, tickers] = await Promise.all([
    fetchJson(`${BASE}/fapi/v1/exchangeInfo`),
    fetchJson(`${BASE}/fapi/v1/ticker/24hr`)
  ]);
  const usdtPerps = new Set(
    exchangeInfo.symbols
      .filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
      .map(s => s.symbol)
  );
  const eligible = tickers
    .filter(t => usdtPerps.has(t.symbol) && parseFloat(t.quoteVolume) >= minVolumeUsd)
    .map(t => ({ symbol: t.symbol, quoteVolume: parseFloat(t.quoteVolume) }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
  return eligible.slice(0, limit);
}

// 24h ticker snapshot (volume + price change) for a single symbol — used to
// record real market conditions (volume, volatility context) on ENTER trades.
async function fetch24hTicker(symbol) {
  const data = await fetchJson(`${BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
  return {
    quoteVolume: parseFloat(data.quoteVolume),
    priceChangePercent: parseFloat(data.priceChangePercent)
  };
}

module.exports = { fetchKlines, fetchCurrentPrice, fetchTopVolumeUniverse, fetch24hTicker };
