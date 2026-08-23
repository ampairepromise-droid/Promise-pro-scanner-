// ============================================================================
// TRADING SESSION — DISPLAY ONLY (spec sections 33-35, 58)
// ============================================================================
// Pure function of the current time. Never touches signal logic, never
// blocks or filters ENTER/WAIT, never gates a trade. Informational only.
// Sessions are defined in UTC internally (unambiguous, no DST guessing) and
// reported alongside the EAT clock (EAT is UTC+3, fixed, no DST) for display.
// ============================================================================

// Conventional approximate session windows in UTC.
const SESSIONS = [
  { name: 'Asia', emoji: '🌏', startUTC: 0, endUTC: 9 },
  { name: 'London', emoji: '🇬🇧', startUTC: 7, endUTC: 16 },
  { name: 'New York', emoji: '🇺🇸', startUTC: 12, endUTC: 21 }
];

function activeSessionsAt(utcHour) {
  return SESSIONS.filter(s => {
    if (s.startUTC <= s.endUTC) return utcHour >= s.startUTC && utcHour < s.endUTC;
    return utcHour >= s.startUTC || utcHour < s.endUTC; // wraps midnight (not used currently, kept for safety)
  });
}

function getCurrentSession(now = new Date()) {
  const utcHour = now.getUTCHours();
  const active = activeSessionsAt(utcHour);

  const eat = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(now);

  if (active.length === 0) {
    return { label: '🌙 Off-Session (low liquidity)', sessions: [], overlap: false, eat };
  }
  if (active.length >= 2) {
    const label = `🔥 ${active.map(s => s.name).join(' × ')} OVERLAP`;
    return { label, sessions: active.map(s => s.name), overlap: true, eat };
  }
  const s = active[0];
  return { label: `${s.emoji} ${s.name} Session`, sessions: [s.name], overlap: false, eat };
}

module.exports = { getCurrentSession };
