// Proxy to ESPN public soccer API — no auth/token required.
// Frontend calls: /api/sports?competition=CL&date=2026-05-06

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const LEAGUE_MAP = {
  'CL':  'uefa.champions',
  'UEL': 'uefa.europa',
  'PL':  'eng.1',
  'LL':  'esp.1',
  'BL':  'ger.1',
  'SA':  'ita.1',
};

function mapStatus(comp) {
  const st = comp.status?.type;
  if (!st) return { short: 'NS', long: 'Not Started', elapsed: null };

  const name   = st.name || '';
  const detail = (st.shortDetail || '').toLowerCase();

  if (st.completed || name === 'STATUS_FINAL' || name === 'STATUS_FULL_TIME') {
    return { short: 'FT', long: 'Match Finished', elapsed: 90 };
  }
  if (name === 'STATUS_HALFTIME' || detail === 'ht' || detail === 'half time') {
    return { short: 'HT', long: 'Half Time', elapsed: 45 };
  }
  if (name === 'STATUS_IN_PROGRESS') {
    const period  = comp.status?.period || 1;
    const elapsed = parseInt(comp.status?.displayClock) || null;
    return { short: period <= 1 ? '1H' : '2H', long: 'In Play', elapsed };
  }
  if (name === 'STATUS_POSTPONED')  return { short: 'PST',  long: 'Postponed',  elapsed: null };
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') {
    return { short: 'CANC', long: 'Cancelled', elapsed: null };
  }
  if (name === 'STATUS_SUSPENDED') return { short: 'PST',  long: 'Suspended',  elapsed: null };

  return { short: 'NS', long: st.description || 'Not Started', elapsed: null };
}

function mapMatch(event) {
  const comp     = event.competitions?.[0];
  if (!comp) return null;

  const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
  const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;

  return {
    fixture: {
      id:     event.id,
      date:   event.date,
      status: mapStatus(comp),
    },
    league: {
      id:    event.season?.year,
      name:  event.season?.slug?.includes('champions') ? 'UEFA Champions League'
             : (event.name || 'Soccer'),
      round: comp.series?.summary || event.seasonType?.name || '',
    },
    teams: {
      home: {
        id:   homeComp.team?.id,
        name: homeComp.team?.shortDisplayName || homeComp.team?.displayName || homeComp.team?.name || 'Local',
        logo: homeComp.team?.logo,
      },
      away: {
        id:   awayComp.team?.id,
        name: awayComp.team?.shortDisplayName || awayComp.team?.displayName || awayComp.team?.name || 'Visita',
        logo: awayComp.team?.logo,
      },
    },
    goals: {
      home: parseInt(homeComp.score || '0', 10),
      away: parseInt(awayComp.score || '0', 10),
    },
  };
}

module.exports = async function handler(req, res) {
  const competition = (req.query?.competition || 'CL').toString();
  const date        = (req.query?.date || new Date().toISOString().slice(0, 10)).toString();

  const league    = LEAGUE_MAP[competition] || 'uefa.champions';
  const dateParam = date.replace(/-/g, ''); // YYYYMMDD

  const url = `${ESPN_BASE}/${league}/scoreboard?dates=${dateParam}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });

    if (!r.ok) {
      return res.status(r.status).json({
        errors:   { api: `ESPN HTTP ${r.status}` },
        response: [],
      });
    }

    const data    = await r.json();
    const matches = (data.events || []).map(mapMatch).filter(Boolean);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({ response: matches, errors: {}, results: matches.length });
  } catch (e) {
    return res.status(502).json({ errors: { proxy: e.message }, response: [] });
  }
};
