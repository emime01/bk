// Movimagen Billboard Worker
// Routes:
//   GET  /api/sports?competition=CL&date=YYYY-MM-DD  — ESPN proxy
//   GET  /api/config?client=slug                      — client config (KV)
//   POST /api/config?client=slug                      — save client config
//   GET  /api/clients                                  — list all clients
//   POST /api/clients                                  — create client {slug, name}
//   DELETE /api/clients/:slug                          — delete client
//   GET  /c/:slug                                      — serve display page

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
  URU: 'uru.1',
  URU2:'uru.2',
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
  URU: 'Primera División Uruguay',
  URU2:'Segunda División Uruguay',
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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sanitizeBody(body) {
  if (body.backgrounds) {
    for (const k of Object.keys(body.backgrounds)) {
      if (typeof body.backgrounds[k] === 'string' && body.backgrounds[k].startsWith('data:')) {
        body.backgrounds[k] = null;
      }
    }
  }
  return body;
}

// ── Sports handler ────────────────────────────────────

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

// ── Multi-client config handlers ──────────────────────

const CLIENTS_LIST_KEY = 'mv_clients';
const clientCfgKey = slug => `mv_client_${slug}`;

// Legacy single-config key (backward compat)
const LEGACY_KEY = 'bk_config_v1';

async function handleClientList(env) {
  if (!env.CONFIG_KV) return jsonRes([], 200);
  try {
    const list = await env.CONFIG_KV.get(CLIENTS_LIST_KEY, 'json') || [];
    return jsonRes(list, 200);
  } catch { return jsonRes([], 200); }
}

async function handleClientCreate(request, env) {
  if (!env.CONFIG_KV) return jsonRes({ error: 'KV not configured' }, 503);
  const { slug, name } = await request.json();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonRes({ error: 'Slug inválido (solo letras minúsculas, números y guiones)' }, 400);
  }
  let list = await env.CONFIG_KV.get(CLIENTS_LIST_KEY, 'json') || [];
  if (list.find(c => c.slug === slug)) {
    return jsonRes({ error: 'El slug ya existe' }, 409);
  }
  list.push({ slug, name: name || slug, createdAt: new Date().toISOString() });
  await env.CONFIG_KV.put(CLIENTS_LIST_KEY, JSON.stringify(list));
  await env.CONFIG_KV.put(clientCfgKey(slug), JSON.stringify({}));
  return jsonRes({ ok: true, slug });
}

async function handleClientDelete(slug, env) {
  if (!env.CONFIG_KV) return jsonRes({ error: 'KV not configured' }, 503);
  let list = await env.CONFIG_KV.get(CLIENTS_LIST_KEY, 'json') || [];
  list = list.filter(c => c.slug !== slug);
  await env.CONFIG_KV.put(CLIENTS_LIST_KEY, JSON.stringify(list));
  await env.CONFIG_KV.delete(clientCfgKey(slug));
  return jsonRes({ ok: true });
}

async function handleConfigGet(slug, env) {
  if (!env.CONFIG_KV) return jsonRes({}, 200);
  try {
    const key = slug ? clientCfgKey(slug) : LEGACY_KEY;
    const val = await env.CONFIG_KV.get(key, 'json');
    return jsonRes(val || {}, 200);
  } catch { return jsonRes({}, 200); }
}

async function handleConfigPost(slug, request, env) {
  if (!env.CONFIG_KV) return jsonRes({ ok: false, error: 'KV not configured' }, 503);
  try {
    const body = sanitizeBody(await request.json());
    const key  = slug ? clientCfgKey(slug) : LEGACY_KEY;
    await env.CONFIG_KV.put(key, JSON.stringify(body));
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

    // Sports API (ESPN proxy)
    if (url.pathname === '/api/sports') {
      return handleSports(url);
    }

    // Client config
    if (url.pathname === '/api/config') {
      const slug = url.searchParams.get('client') || null;
      if (request.method === 'GET')  return handleConfigGet(slug, env);
      if (request.method === 'POST') return handleConfigPost(slug, request, env);
    }

    // Client management
    if (url.pathname === '/api/clients') {
      if (request.method === 'GET')  return handleClientList(env);
      if (request.method === 'POST') return handleClientCreate(request, env);
    }
    const clientDeleteMatch = url.pathname.match(/^\/api\/clients\/([a-z0-9-]+)$/);
    if (clientDeleteMatch && request.method === 'DELETE') {
      return handleClientDelete(clientDeleteMatch[1], env);
    }

    // Client display page — serve index.html at /c/:slug
    if (url.pathname.startsWith('/c/')) {
      const indexReq = new Request(new URL('/index.html', request.url), request);
      return env.ASSETS.fetch(indexReq);
    }

    // Static assets
    return env.ASSETS.fetch(request);
  },
};
