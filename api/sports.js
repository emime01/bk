// Proxy to ESPN public soccer API — no auth/token required.
//
// Two modes:
//   1) /api/sports?competition=CL&date=2026-05-06
//      → list of matches that day (scoreboard)
//   2) /api/sports?competition=CL&event=12345
//      → events (goals, cards, subs) + team stats for one match (summary)

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const LEAGUE_MAP = {
  'CL':   'uefa.champions',
  'UEL':  'uefa.europa',
  'PL':   'eng.1',
  'LL':   'esp.1',
  'BL':   'ger.1',
  'SA':   'ita.1',
  'LIB':  'conmebol.libertadores',
  'SUD':  'conmebol.sudamericana',
  'URU':  'uru.1',
  'URU2': 'uru.2',
  'ARG':  'arg.1',
};

const LEAGUE_NAMES = {
  'CL':   'UEFA Champions League',
  'UEL':  'UEFA Europa League',
  'PL':   'Premier League',
  'LL':   'LaLiga',
  'BL':   'Bundesliga',
  'SA':   'Serie A',
  'LIB':  'Copa Libertadores',
  'SUD':  'Copa Sudamericana',
  'URU':  'Primera División Uruguay',
  'URU2': 'Segunda División Uruguay',
  'ARG':  'Primera División Argentina',
};

function mapStatus(comp) {
  const st = comp.status?.type;
  if (!st) return { short: 'NS', long: 'Not Started', elapsed: null };

  const name      = st.name  || '';
  const stateCode = st.state || '';          // ESPN: 'pre' | 'in' | 'post'
  const detail    = (st.shortDetail || '').toLowerCase();

  // Finished
  if (stateCode === 'post' || st.completed ||
      name === 'STATUS_FINAL' || name === 'STATUS_FULL_TIME') {
    return { short: 'FT', long: 'Match Finished', elapsed: 90 };
  }
  // Half time (check before generic 'in' so it wins)
  if (name === 'STATUS_HALFTIME' || detail.includes('ht') || detail.includes('half time') || detail.includes('halftime')) {
    return { short: 'HT', long: 'Half Time', elapsed: 45 };
  }
  // In play — covers STATUS_IN_PROGRESS, STATUS_FIRST_HALF, STATUS_SECOND_HALF, etc.
  if (stateCode === 'in' || name === 'STATUS_IN_PROGRESS' ||
      name === 'STATUS_FIRST_HALF' || name === 'STATUS_SECOND_HALF' ||
      name === 'STATUS_EXTRA_TIME' || name === 'STATUS_OVERTIME') {
    const period  = comp.status?.period || 1;
    // displayClock is "40:00" or "40'" — parseInt handles both
    const elapsed = parseInt(comp.status?.displayClock) ||
                    Math.round((comp.status?.clock || 0) / 60) || null;
    let short = '2H';
    if (name === 'STATUS_EXTRA_TIME' || name === 'STATUS_OVERTIME') short = 'ET';
    else short = period <= 1 ? '1H' : '2H';
    return { short, long: 'In Play', elapsed };
  }
  if (name === 'STATUS_POSTPONED')  return { short: 'PST',  long: 'Postponed',  elapsed: null };
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') {
    return { short: 'CANC', long: 'Cancelled', elapsed: null };
  }
  if (name === 'STATUS_SUSPENDED') return { short: 'PST',  long: 'Suspended',  elapsed: null };

  return { short: 'NS', long: st.description || name || 'Not Started', elapsed: null };
}

function mapMatch(event, leagueName) {
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
      name:  leagueName || event.name || 'Soccer',
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

// ── SUMMARY (live events + stats) ────────────────────
function mapEvents(summary) {
  const plays = summary.plays || summary.keyEvents || [];

  return plays
    .map(p => {
      const txt = (p.type?.text || '').toLowerCase();
      let type   = null;
      let detail = null;

      if (txt.includes('goal') && !txt.includes('no goal') && !txt.includes('disallow')) {
        type = 'Goal';
      } else if (txt.includes('yellow card')) {
        type = 'Card';
        detail = 'Yellow Card';
      } else if (txt.includes('red card')) {
        type = 'Card';
        detail = 'Red Card';
      } else if (txt.includes('substitution')) {
        type = 'subst';
      } else if (p.scoringPlay) {
        type = 'Goal';
      } else {
        return null;
      }

      const clockTxt = (p.clock?.displayValue || '').replace("'", '').trim();
      const elapsed  = parseInt(clockTxt) || null;

      const player = p.participants?.[0]?.athlete?.displayName
                  || p.participants?.[0]?.athlete?.shortName
                  || p.athletesInvolved?.[0]?.displayName
                  || '—';

      return {
        type,
        detail,
        time: { elapsed },
        player: { name: player },
        team:   { id: p.team?.id ? String(p.team.id) : null, name: '' },
      };
    })
    .filter(Boolean);
}

function statValue(team, names) {
  if (!team?.statistics) return null;
  for (const n of names) {
    const s = team.statistics.find(st => st.name === n || st.abbreviation === n);
    if (s?.displayValue !== undefined && s.displayValue !== '') return s.displayValue;
  }
  return null;
}

function mapStats(summary) {
  const teams = summary.boxscore?.teams || [];
  if (teams.length < 2) return null;

  const pick = (t) => ({
    possession:    statValue(t, ['possessionPct', 'POS']) || '—',
    shots:         statValue(t, ['totalShots', 'SH'])     || '—',
    shotsOnTarget: statValue(t, ['shotsOnTarget', 'SOT']) || '—',
    corners:       statValue(t, ['wonCorners', 'cornerKicks', 'C']) || '—',
    fouls:         statValue(t, ['foulsCommitted', 'F']) || '—',
    yellow:        statValue(t, ['yellowCards', 'YC'])   || '—',
    red:           statValue(t, ['redCards', 'RC'])      || '—',
  });

  // ESPN puts home team first in boxscore.teams when homeAway flag matches.
  const homeTeam = teams.find(t => t.homeAway === 'home') || teams[0];
  const awayTeam = teams.find(t => t.homeAway === 'away') || teams[1];

  return { home: pick(homeTeam), away: pick(awayTeam) };
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) {
    const err = new Error(`ESPN HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

module.exports = async function handler(req, res) {
  const competition = (req.query?.competition || 'CL').toString();
  const league      = LEAGUE_MAP[competition] || 'uefa.champions';

  // Mode 2: single-event summary
  if (req.query?.event) {
    const eventId = String(req.query.event);
    const url     = `${ESPN_BASE}/${league}/summary?event=${encodeURIComponent(eventId)}`;
    try {
      const data   = await fetchJson(url);
      const events = mapEvents(data);
      const stats  = mapStats(data);
      res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
      return res.status(200).json({ events, stats, errors: {} });
    } catch (e) {
      return res.status(e.status || 502).json({
        errors: { api: e.message },
        events: [],
        stats:  null,
      });
    }
  }

  // Mode 1: scoreboard for a date
  const date      = (req.query?.date || new Date().toISOString().slice(0, 10)).toString();
  const dateParam = date.replace(/-/g, ''); // YYYYMMDD
  const url       = `${ESPN_BASE}/${league}/scoreboard?dates=${dateParam}`;

  try {
    const data    = await fetchJson(url);
    const matches = (data.events || [])
      .map(e => mapMatch(e, LEAGUE_NAMES[competition]))
      .filter(Boolean);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({ response: matches, errors: {}, results: matches.length });
  } catch (e) {
    return res.status(e.status || 502).json({
      errors:   { api: e.message },
      response: [],
    });
  }
};
