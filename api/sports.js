// Proxy a api-football. Mantiene la API key fuera del HTML público:
// la key vive en la env var API_FOOTBALL_KEY de Vercel (Project → Settings →
// Environment Variables). Frontend llama: /api/sports?path=fixtures&league=13&...

module.exports = async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return res.status(500).json({ errors: { config: 'API_FOOTBALL_KEY no configurada en Vercel' } });
  }

  const { path = '', ...query } = req.query || {};
  const allowed = ['fixtures', 'fixtures/events', 'status'];
  if (!allowed.includes(path)) {
    return res.status(400).json({ errors: { path: `Path no permitido: ${path}` } });
  }

  const qs = new URLSearchParams(query).toString();
  const url = `https://v3.football.api-sports.io/${path}${qs ? '?' + qs : ''}`;

  try {
    const r = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
    const data = await r.json();
    // CDN 5 min: alcanza para el polling de 5 min y reduce hits a la API.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ errors: { proxy: e.message } });
  }
};
