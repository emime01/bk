// Vercel serverless function — config store backed by Vercel KV (Upstash REST).
// Two endpoints in one handler: GET reads, POST writes.
//
// Setup (una vez):
//   1) Vercel dashboard → Storage → Create → KV (Upstash)
//   2) Connect to project "bk"
//   3) Vercel inyecta KV_REST_API_URL y KV_REST_API_TOKEN automáticamente
//
// Sin KV configurado, GET devuelve {} (la placa cae a localStorage) y POST devuelve 503.
// El worker.js (Cloudflare) hace lo mismo con Cloudflare KV — los dos coexisten.

const KEY = 'bk_config_v1';

async function kvGet() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.result) return {};
  try {
    let parsed = JSON.parse(data.result);
    // Handle legacy double-encoded values: parse again if it's still a string.
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch {}
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function kvSet(value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    try {
      const cfg = await kvGet();
      return res.status(200).json(cfg ?? {});
    } catch (e) {
      return res.status(200).json({});
    }
  }

  if (req.method === 'POST') {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(503).json({ ok: false, error: 'KV not configured (enable Vercel KV in Storage tab)' });
    }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      // Strip base64 backgrounds — too large for KV / polling.
      if (body.backgrounds && typeof body.backgrounds === 'object') {
        for (const k of Object.keys(body.backgrounds)) {
          if (typeof body.backgrounds[k] === 'string' && body.backgrounds[k].startsWith('data:')) {
            body.backgrounds[k] = null;
          }
        }
      }
      const ok = await kvSet(body);
      return res.status(ok ? 200 : 500).json({ ok });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
