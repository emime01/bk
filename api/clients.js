// Vercel serverless function — multi-client list management.
// GET  /api/clients           → list all clients [{slug, name, createdAt}]
// POST /api/clients           → create client {slug, name}
// DELETE /api/clients?slug=x  → delete client

const CLIENTS_KEY  = 'mv_clients';
const clientCfgKey = slug => `mv_client_${slug}`;

const KV_URL   = () => process.env.KV_REST_API_URL;
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN;

function hasKV() { return !!(KV_URL() && KV_TOKEN()); }

async function kvGet(key) {
  const r = await fetch(`${KV_URL()}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN()}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.result) return null;
  try {
    let v = JSON.parse(data.result);
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
    return v;
  } catch { return null; }
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL()}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
  return r.ok;
}

async function kvDelete(key) {
  const r = await fetch(`${KV_URL()}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN()}` },
  });
  return r.ok;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // GET — list clients
  if (req.method === 'GET') {
    if (!hasKV()) return res.status(200).json([]);
    try {
      const list = await kvGet(CLIENTS_KEY) || [];
      return res.status(200).json(Array.isArray(list) ? list : []);
    } catch { return res.status(200).json([]); }
  }

  // POST — create client
  if (req.method === 'POST') {
    if (!hasKV()) return res.status(503).json({ error: 'KV not configured' });
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { slug, name } = body;
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Slug inválido (solo letras minúsculas, números y guiones)' });
      }
      let list = await kvGet(CLIENTS_KEY) || [];
      if (!Array.isArray(list)) list = [];
      if (list.find(c => c.slug === slug)) {
        return res.status(409).json({ error: 'El slug ya existe' });
      }
      list.push({ slug, name: name || slug, createdAt: new Date().toISOString() });
      await kvSet(CLIENTS_KEY, list);
      await kvSet(clientCfgKey(slug), {});
      return res.status(200).json({ ok: true, slug });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE — remove client (slug via query string: ?slug=burger-king)
  if (req.method === 'DELETE') {
    if (!hasKV()) return res.status(503).json({ error: 'KV not configured' });
    const slug = req.query?.slug;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    try {
      let list = await kvGet(CLIENTS_KEY) || [];
      if (!Array.isArray(list)) list = [];
      list = list.filter(c => c.slug !== slug);
      await kvSet(CLIENTS_KEY, list);
      await kvDelete(clientCfgKey(slug));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
