const store = require('../lib/store');
const regimeLib = require('../lib/regime');
const sessionLib = require('../lib/session');
const adaptive = require('../lib/adaptive');
const tradeMemory = require('../lib/tradeMemory');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = sessionLib.getCurrentSession();

  let regime = null, diagnostics = null, insights = null;
  if (store.configured()) {
    try {
      regime = await regimeLib.getCurrentRegime();
      diagnostics = await store.getJSON('scan:lastDiagnostics');
      const [allTrades, resolvedTrades, model] = await Promise.all([
        tradeMemory.getAllTrades(),
        tradeMemory.getResolvedTrades(),
        adaptive.getCurrentModel()
      ]);
      insights = adaptive.buildInsights(allTrades, resolvedTrades, model);
    } catch (err) {
      return res.status(200).json({
        session, regime: null, diagnostics: null, insights: null,
        warning: `Storage read error: ${err.message}`
      });
    }
  }

  return res.status(200).json({ session, regime, diagnostics, insights });
};
