// Proxy a football-data.org. Mantiene la API key fuera del HTML público:
// la key vive en la env var FOOTBALL_DATA_TOKEN de Vercel (Project →
// Settings → Environment Variables).
//
// Frontend llama: /api/sports?competition=CL&date=2026-05-06
// Devuelve la respuesta normalizada al shape de api-sports (que es el que
// usa el HTML), así no hay que reescribir el front si volvemos a cambiar
// de proveedor.

const FD_BASE = 'https://api.football-data.org/v4';

// status football-data.org → códigos cortos estilo api-sports
function mapStatus(s, minute) {
  if (s === 'IN_PLAY')          return (minute && minute <= 45) ? '1H' : '2H';
  if (s === 'PAUSED')           return 'HT';
  if (s === 'EXTRA_TIME')       return 'ET';
  if (s === 'PENALTY_SHOOTOUT') return 'P';
  if (s === 'FINISHED')         return 'FT';
  if (s === 'AWARDED')          return 'FT';
  if (s === 'POSTPONED')        return 'PST';
  if (s === 'SUSPENDED')        return 'PST';
  if (s === 'CANCELLED')        return 'CANC';
  return 'NS';
}

function mapMatch(m) {
  const home = m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? 0;
  const away = m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? 0;
  return {
    fixture: {
      id:   m.id,
      date: m.utcDate,
      status: {
        short:   mapStatus(m.status, m.minute),
        long:    m.status,
        elapsed: m.minute ?? null
      }
    },
    league: {
      id:    m.competition?.id,
      name:  m.competition?.name || 'UEFA Champions League',
      round: m.stage || ''
    },
    teams: {
      home: {
        id:   m.homeTeam?.id,
        name: m.homeTeam?.shortName || m.homeTeam?.name || 'Local',
        logo: m.homeTeam?.crest
      },
      away: {
        id:   m.awayTeam?.id,
        name: m.awayTeam?.shortName || m.awayTeam?.name || 'Visita',
        logo: m.awayTeam?.crest
      }
    },
    goals: { home, away }
  };
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.FOOTBALL_DATA_TOKEN;
  if (!apiKey) {
    return res.status(500).json({
      errors: { config: 'FOOTBALL_DATA_TOKEN no configurada en Vercel' },
      response: []
    });
  }

  const competition = (req.query?.competition || 'CL').toString();
  const date = (req.query?.date || new Date().toISOString().slice(0, 10)).toString();

  const url = `${FD_BASE}/matches?competitions=${encodeURIComponent(competition)}` +
              `&dateFrom=${encodeURIComponent(date)}&dateTo=${encodeURIComponent(date)}`;

  try {
    const r = await fetch(url, { headers: { 'X-Auth-Token': apiKey } });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        errors: { api: data.message || data.error || `HTTP ${r.status}` },
        response: []
      });
    }
    const matches = (data.matches || []).map(mapMatch);
    // CDN cache 60s. Suficiente para el polling y reduce hits a la API.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({ response: matches, errors: {}, results: matches.length });
  } catch (e) {
    return res.status(502).json({ errors: { proxy: e.message }, response: [] });
  }
};
