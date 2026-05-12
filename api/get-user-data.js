// ============================================================
// /api/get-user-data.js
// Vercel serverless function for /start-2 and /onboarding pages
// Looks up user data in Supabase by discount code OR email
// ============================================================
//
// Usage 1 (discount code lookup):
//   GET /api/get-user-data?code=danilozdravkovic-umpmo167-llc10
//
// Usage 2 (email lookup, for /onboarding page):
//   GET /api/get-user-data?email=danilo@floumate.com
//
// Response (200):
//   {
//     found: true,
//     data: { email, phone, llc_name, industry, state, owner_first, ... }
//   }
//
// Response (404):
//   { found: false, error: "code_not_found" | "email_not_found" }
//
// Response (400):
//   { found: false, error: "invalid_code_format" | "invalid_email_format" | "missing_param" }
//
// Response (500):
//   { found: false, error: "server_error", details: "..." }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_TABLE = 'start_partial_submissions';

// CORS: allow requests from formio.biz and Vercel preview domains
const ALLOWED_ORIGINS = [
  'https://formio.biz',
  'https://www.formio.biz',
  'http://localhost:3000',
  'http://localhost:8000'
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://formio.biz');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isValidCodeFormat(code) {
  // Expected format: imeprezime-XXXXXXXX-llcNN  (where NN = 10|20|30)
  return /^[a-z0-9]+-[a-z0-9]{6,12}-llc(10|20|30)$/i.test(code);
}

function isValidEmailFormat(email) {
  // Basic email regex - good enough for filtering
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatResponseData(row, matchedTier) {
  // Returns clean payload for frontend (omits internal columns we don't need to expose)
  return {
    // Discount info (only relevant if matched by code)
    discount_tier: matchedTier,
    discount_slug: row.discount_slug || '',
    discount_unique_id: row.discount_unique_id || '',
    
    // Contact
    email: row.email || '',
    phone: row.phone || '',
    phone_dial_code: row.phone_dial_code || '',
    phone_local: row.phone_local || '',
    phone_country_code: row.phone_country_code || '',
    
    // Owner name
    first_name: row.first_name || '',
    last_name: row.last_name || '',
    full_name: row.full_name || '',
    
    // LLC
    llc_name: row.llc_name || '',
    llc_name_full: row.llc_name_full || '',
    
    // Industry
    industry: row.industry || '',
    industry_label: row.industry_label || '',
    
    // Registration State
    registration_state: row.registration_state || '',
    registration_state_label: row.registration_state_label || '',
    
    // Address
    address_street: row.address_street || '',
    address_city: row.address_city || '',
    address_postal: row.address_postal || '',
    address_country: row.address_country || '',
    address_country_code: row.address_country_code || '',
    
    // Plan (if user selected one)
    selected_plan: row.selected_plan || '',
    selected_plan_label: row.selected_plan_label || '',
    selected_price: row.selected_price || '',
    
    // Session
    session_id: row.session_id || ''
  };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  
  // Handle preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Only GET allowed
  if (req.method !== 'GET') {
    return res.status(405).json({ found: false, error: 'method_not_allowed' });
  }
  
  // Validate env vars
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).json({ found: false, error: 'server_misconfigured' });
  }
  
  // Get parameters
  const rawCode = (req.query.code || '').trim().toLowerCase();
  const rawEmail = (req.query.email || '').trim().toLowerCase();
  
  // Need at least one identifier
  if (!rawCode && !rawEmail) {
    return res.status(400).json({ found: false, error: 'missing_param', details: 'Provide ?code= or ?email=' });
  }
  
  let queryUrl;
  let lookupType;
  
  if (rawCode) {
    // === LOOKUP BY DISCOUNT CODE ===
    if (!isValidCodeFormat(rawCode)) {
      return res.status(400).json({ found: false, error: 'invalid_code_format' });
    }
    
    // Search across all 3 discount code columns
    const orFilter = [
      `discount_code_10_internal.eq.${rawCode}`,
      `discount_code_20_internal.eq.${rawCode}`,
      `discount_code_30_internal.eq.${rawCode}`
    ].join(',');
    
    queryUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?or=(${orFilter})&limit=1`;
    lookupType = 'code';
  } else {
    // === LOOKUP BY EMAIL ===
    if (!isValidEmailFormat(rawEmail)) {
      return res.status(400).json({ found: false, error: 'invalid_email_format' });
    }
    
    queryUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?email=eq.${encodeURIComponent(rawEmail)}&limit=1`;
    lookupType = 'email';
  }
  
  try {
    const supabaseResponse = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Accept': 'application/json'
      }
    });
    
    if (!supabaseResponse.ok) {
      const errText = await supabaseResponse.text();
      console.error('Supabase error:', supabaseResponse.status, errText);
      return res.status(500).json({
        found: false,
        error: 'supabase_error',
        details: errText.substring(0, 200)
      });
    }
    
    const rows = await supabaseResponse.json();
    
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        found: false,
        error: lookupType === 'code' ? 'code_not_found' : 'email_not_found'
      });
    }
    
    const row = rows[0];
    
    // For code lookup, determine which tier matched
    let matchedTier = null;
    if (lookupType === 'code') {
      if (row.discount_code_10_internal === rawCode) matchedTier = 10;
      else if (row.discount_code_20_internal === rawCode) matchedTier = 20;
      else if (row.discount_code_30_internal === rawCode) matchedTier = 30;
    }
    
    return res.status(200).json({
      found: true,
      lookup_type: lookupType,
      data: formatResponseData(row, matchedTier)
    });
    
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({
      found: false,
      error: 'server_error',
      details: String(err).substring(0, 200)
    });
  }
}
