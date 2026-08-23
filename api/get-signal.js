const store = require('../lib/store');
const { fetchKlines, fetchCurrentPrice } = require('../lib/binance');
const { evaluateSymbol } = require('../lib/engine');

// GET /api/get-signal?id=<setupId>
// Returns the frozen record from the moment of notification, PLUS a fresh
// re-evaluation against live Binance data so the frontend can show
// "SIGNAL STATUS CHANGED" honestly if the setup has since moved on
// (spec section 14). Response shape: { snapshot, live }.
module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!store.configured()) return res.status(500).json({ error: 'Storage not configured' });

  const trade = await store.collectionGet('trades', id);
  if (!trade) return res.status(404).json({ error: 'Signal not found', id });

  const snapshot = {
    setupId: id, symbol: trade.symbol, direction: trade.direction,
    entryPrice: trade.entryPrice, stopLoss: trade.stopLoss, tp1: trade.tp1, tp2: trade.tp2,
    rrRatio: trade.rrRatio, score: trade.score, enteredAt: trade.enteredAt
  };

  let live;
  if (trade.status === 'CLOSED') {
    live = {
      entryStatus: trade.outcome,
      note: 'This trade has already closed',
      currentPrice: trade.pricePath && trade.pricePath.length ? trade.pricePath[trade.pricePath.length - 1].price : null
    };
  } else {
    try {
      const [c4h, c1h, c15m, currentPrice] = await Promise.all([
        fetchKlines(trade.symbol, '4h', 360),
        fetchKlines(trade.symbol, '1h', 168),
        fetchKlines(trade.symbol, '15m', 96),
        fetchCurrentPrice(trade.symbol)
      ]);
      const result = evaluateSymbol(trade.symbol, c4h, c1h, c15m, currentPrice);
      if (result && result.direction === trade.direction) {
        live = { entryStatus: result.entryStatus, currentPrice, stopLoss: result.stopLoss, tp1: result.tp1, tp2: result.tp2 };
      } else {
        live = { entryStatus: 'INVALID', currentPrice, note: 'Original setup no longer meets structural conditions' };
      }
    } catch {
      live = { entryStatus: 'UNKNOWN', note: 'Could not re-check live status right now' };
    }
  }

  return res.status(200).json({ snapshot, live });
};
