// Vercel serverless function — config store backed by Vercel KV (Upstash REST).
// GET  /api/config?client=slug  → read client config
// POST /api/config?client=slug  → write client config
// (no ?client → legacy single-key mode for backward compat)
//
// Setup (una vez):
//   1) Vercel dashboard → Storage → Create → KV (Upstash)
//   2) Connect to project "bk"
//   3) Vercel inyecta KV_REST_API_URL y KV_REST_API_TOKEN automáticamente
//
// Sin KV configurado, GET devuelve {} y POST devuelve 503.

const LEGACY_KEY   = 'bk_config_v1';
const clientKey    = slug => `mv_client_${slug}`;

const KV_URL   = () => process.env.KV_REST_API_URL;
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const url = KV_URL();
  const token = KV_TOKEN();
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.result) return {};
  try {
    let parsed = JSON.parse(data.result);
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch {}
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function kvSet(key, value) {
  const url = KV_URL();
  const token = KV_TOKEN();
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
  return r.ok;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Vercel populates req.query from URL query string
  const slug = (req.query && req.query.client) ? String(req.query.client) : null;
  const key  = slug ? clientKey(slug) : LEGACY_KEY;

  if (req.method === 'GET') {
    try {
      const cfg = await kvGet(key);
      return res.status(200).json(cfg ?? {});
    } catch {
      return res.status(200).json({});
    }
  }

  if (req.method === 'POST') {
    if (!KV_URL() || !KV_TOKEN()) {
      return res.status(503).json({ ok: false, error: 'KV not configured (enable Vercel KV in Storage tab)' });
    }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      if (body.backgrounds && typeof body.backgrounds === 'object') {
        for (const k of Object.keys(body.backgrounds)) {
          if (typeof body.backgrounds[k] === 'string' && body.backgrounds[k].startsWith('data:')) {
            body.backgrounds[k] = null;
          }
        }
      }
      const ok = await kvSet(key, body);
      return res.status(ok ? 200 : 500).json({ ok });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
