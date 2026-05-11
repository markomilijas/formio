// /api/mark-code-used.js
// Called by frontend after successful Stripe payment on /start-2
// Marks discount code as used in Supabase (sets code_NN_used_at = NOW())
//
// Request body (POST):
//   {
//     "code": "danilozdravkovic-umpmo167-llc10",
//     "tier": 10,
//     "payment_intent_id": "pi_xxx"  // for audit trail
//   }
//
// Response (200): { ok: true }
// Response (400/404/500): { ok: false, error: "..." }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_TABLE = 'start_partial_submissions';

const ALLOWED_ORIGINS = [
  'https://formio.biz',
  'https://www.formio.biz',
  'https://markomilijas.github.io',
  'http://localhost:3000'
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://formio.biz');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isValidCodeFormat(code) {
  return /^[a-z0-9]+-[a-z0-9]{6,12}-llc(10|20|30)$/i.test(code || '');
}

function parseTier(code) {
  const m = (code || '').match(/-llc(10|20|30)$/i);
  return m ? parseInt(m[1], 10) : null;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(500).json({ ok: false, error: 'server_misconfigured' });
  }
  
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
  }
  body = body || {};
  
  const code = (body.code || '').trim().toLowerCase();
  const paymentIntentId = (body.payment_intent_id || '').trim();
  
  if (!isValidCodeFormat(code)) {
    return res.status(400).json({ ok: false, error: 'invalid_code_format' });
  }
  
  const tier = parseTier(code);
  if (!tier) {
    return res.status(400).json({ ok: false, error: 'invalid_tier' });
  }
  
  // Update the row where this code matches
  // We use PATCH on PostgREST with filter
  const tierCol = `discount_code_${tier}_internal`;
  const usedAtCol = `code_${tier}_used_at`;
  
  const updateUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?${tierCol}=eq.${encodeURIComponent(code)}`;
  
  const patchBody = {};
  patchBody[usedAtCol] = new Date().toISOString();
  
  try {
    const supabaseResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(patchBody)
    });
    
    if (!supabaseResponse.ok) {
      const errText = await supabaseResponse.text();
      console.error('Supabase PATCH failed:', supabaseResponse.status, errText);
      return res.status(500).json({
        ok: false,
        error: 'supabase_error',
        details: errText.substring(0, 200)
      });
    }
    
    const updated = await supabaseResponse.json();
    
    if (!Array.isArray(updated) || updated.length === 0) {
      return res.status(404).json({ ok: false, error: 'code_not_found' });
    }
    
    return res.status(200).json({
      ok: true,
      tier: tier,
      used_at: updated[0][usedAtCol],
      payment_intent_id: paymentIntentId
    });
    
  } catch (err) {
    console.error('mark-code-used error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      details: String(err).substring(0, 200)
    });
  }
}
