// Cloudflare Worker — BK Billboard
// Routes: /api/sports (ESPN proxy) · /api/config (KV store) · everything else → assets

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const LEAGUE_MAP = {
  CL:  'uefa.champions',
  UEL: 'uefa.europa',
  PL:  'eng.1',
  LL:  'esp.1',
  BL:  'ger.1',
  SA:  'ita.1',
  LIB: 'conmebol.libertadores',
  SUD: 'conmebol.sudamericana',
};

const LEAGUE_NAMES = {
  CL:  'UEFA Champions League',
  UEL: 'UEFA Europa League',
  PL:  'Premier League',
  LL:  'LaLiga',
  BL:  'Bundesliga',
  SA:  'Serie A',
  LIB: 'Copa Libertadores',
  SUD: 'Copa Sudamericana',
};

// ── ESPN data mapping ─────────────────────────────────

function mapStatus(comp) {
  const st = comp.status?.type;
  if (!st) return { short: 'NS', long: 'Not Started', elapsed: null };

  const name      = st.name  || '';
  const stateCode = st.state || '';
  const detail    = (st.shortDetail || '').toLowerCase();

  if (stateCode === 'post' || st.completed ||
      name === 'STATUS_FINAL' || name === 'STATUS_FULL_TIME') {
    return { short: 'FT', long: 'Match Finished', elapsed: 90 };
  }
  if (name === 'STATUS_HALFTIME' || detail.includes('ht') ||
      detail.includes('half time') || detail.includes('halftime')) {
    return { short: 'HT', long: 'Half Time', elapsed: 45 };
  }
  if (stateCode === 'in' || name === 'STATUS_IN_PROGRESS' ||
      name === 'STATUS_FIRST_HALF' || name === 'STATUS_SECOND_HALF' ||
      name === 'STATUS_EXTRA_TIME' || name === 'STATUS_OVERTIME') {
    const period  = comp.status?.period || 1;
    const elapsed = parseInt(comp.status?.displayClock) ||
                    Math.round((comp.status?.clock || 0) / 60) || null;
    let short = period <= 1 ? '1H' : '2H';
    if (name === 'STATUS_EXTRA_TIME' || name === 'STATUS_OVERTIME') short = 'ET';
    return { short, long: 'In Play', elapsed };
  }
  if (name === 'STATUS_POSTPONED')  return { short: 'PST',  long: 'Postponed',  elapsed: null };
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') {
    return { short: 'CANC', long: 'Cancelled', elapsed: null };
  }
  if (name === 'STATUS_SUSPENDED') return { short: 'PST', long: 'Suspended', elapsed: null };
  return { short: 'NS', long: st.description || name || 'Not Started', elapsed: null };
}

function mapMatch(event, leagueName) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
  const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;
  return {
    fixture: { id: event.id, date: event.date, status: mapStatus(comp) },
    league:  { id: event.season?.year, name: leagueName || event.name || 'Soccer', round: comp.series?.summary || event.seasonType?.name || '' },
    teams: {
      home: { id: homeComp.team?.id, name: homeComp.team?.shortDisplayName || homeComp.team?.displayName || homeComp.team?.name || 'Local', logo: homeComp.team?.logo },
      away: { id: awayComp.team?.id, name: awayComp.team?.shortDisplayName || awayComp.team?.displayName || awayComp.team?.name || 'Visita', logo: awayComp.team?.logo },
    },
    goals: { home: parseInt(homeComp.score || '0', 10), away: parseInt(awayComp.score || '0', 10) },
  };
}

function mapEvents(summary) {
  return (summary.plays || summary.keyEvents || [])
    .map(p => {
      const txt = (p.type?.text || '').toLowerCase();
      let type = null, detail = null;
      if (txt.includes('goal') && !txt.includes('no goal') && !txt.includes('disallow')) {
        type = 'Goal';
      } else if (txt.includes('yellow card')) {
        type = 'Card'; detail = 'Yellow Card';
      } else if (txt.includes('red card')) {
        type = 'Card'; detail = 'Red Card';
      } else if (txt.includes('substitution')) {
        type = 'subst';
      } else if (p.scoringPlay) {
        type = 'Goal';
      } else {
        return null;
      }
      const elapsed = parseInt((p.clock?.displayValue || '').replace("'", '').trim()) || null;
      const player  = p.participants?.[0]?.athlete?.displayName
                   || p.participants?.[0]?.athlete?.shortName
                   || p.athletesInvolved?.[0]?.displayName || '—';
      return { type, detail, time: { elapsed }, player: { name: player }, team: { id: p.team?.id ? String(p.team.id) : null, name: '' } };
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
  const pick = t => ({
    possession:    statValue(t, ['possessionPct', 'POS']) || '—',
    shots:         statValue(t, ['totalShots', 'SH'])     || '—',
    shotsOnTarget: statValue(t, ['shotsOnTarget', 'SOT']) || '—',
    corners:       statValue(t, ['wonCorners', 'cornerKicks', 'C']) || '—',
    fouls:         statValue(t, ['foulsCommitted', 'F'])  || '—',
    yellow:        statValue(t, ['yellowCards', 'YC'])    || '—',
    red:           statValue(t, ['redCards', 'RC'])       || '—',
  });
  const homeTeam = teams.find(t => t.homeAway === 'home') || teams[0];
  const awayTeam = teams.find(t => t.homeAway === 'away') || teams[1];
  return { home: pick(homeTeam), away: pick(awayTeam) };
}

// ── Helpers ───────────────────────────────────────────

function jsonRes(data, status = 200, cacheSeconds = 0) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `s-maxage=${cacheSeconds}, stale-while-revalidate=${Math.floor(cacheSeconds / 2)}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Route handlers ────────────────────────────────────

async function handleSports(url) {
  const competition = url.searchParams.get('competition') || 'CL';
  const league      = LEAGUE_MAP[competition] || 'uefa.champions';

  if (url.searchParams.has('event')) {
    const eventId = url.searchParams.get('event');
    const apiUrl  = `${ESPN_BASE}/${league}/summary?event=${encodeURIComponent(eventId)}`;
    try {
      const r = await fetch(apiUrl, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
      const data = await r.json();
      return jsonRes({ events: mapEvents(data), stats: mapStats(data), errors: {} }, 200, 15);
    } catch (e) {
      return jsonRes({ errors: { api: e.message }, events: [], stats: null }, 502);
    }
  }

  const date      = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const dateParam = date.replace(/-/g, '');
  const apiUrl    = `${ESPN_BASE}/${league}/scoreboard?dates=${dateParam}`;
  try {
    const r = await fetch(apiUrl, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
    const data    = await r.json();
    const matches = (data.events || []).map(e => mapMatch(e, LEAGUE_NAMES[competition])).filter(Boolean);
    return jsonRes({ response: matches, errors: {}, results: matches.length }, 200, 60);
  } catch (e) {
    return jsonRes({ errors: { api: e.message }, response: [] }, 502);
  }
}

const CONFIG_KEY = 'bk_config_v1';

async function handleConfigGet(env) {
  if (!env.CONFIG_KV) return jsonRes({}, 200); // KV not set up yet → empty config
  try {
    const val = await env.CONFIG_KV.get(CONFIG_KEY, 'json');
    return jsonRes(val || {}, 200);
  } catch (e) {
    return jsonRes({}, 200);
  }
}

async function handleConfigPost(request, env) {
  if (!env.CONFIG_KV) return jsonRes({ ok: false, error: 'KV not configured' }, 503);
  try {
    const body = await request.json();
    // Strip base64 images before storing (too large for KV / polling)
    if (body.backgrounds) {
      for (const k of Object.keys(body.backgrounds)) {
        if (typeof body.backgrounds[k] === 'string' && body.backgrounds[k].startsWith('data:')) {
          body.backgrounds[k] = null;
        }
      }
    }
    await env.CONFIG_KV.put(CONFIG_KEY, JSON.stringify(body));
    return jsonRes({ ok: true });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}

// ── Main fetch handler ────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/sports') {
      return handleSports(url);
    }

    if (url.pathname === '/api/config') {
      if (request.method === 'GET')  return handleConfigGet(env);
      if (request.method === 'POST') return handleConfigPost(request, env);
    }

    // Fall through to static assets (index.html, admin.html, etc.)
    return env.ASSETS.fetch(request);
  },
};
