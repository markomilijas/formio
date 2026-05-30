// ============================================================
// /api/get-user-data.js
// Vercel serverless function for /start-2, /start-2a and /onboarding pages
// Looks up user data in Supabase by discount code, email, OR uid
// ============================================================
//
// Usage 1 (discount code lookup, for /start-2):
//   GET /api/get-user-data?code=danilozdravkovic-umpmo167-llc10
//
// Usage 2 (email lookup, for /onboarding page):
//   GET /api/get-user-data?email=danilo@floumate.com
//
// Usage 3 (uid lookup, for /start-2a resume page — NO discount):
//   GET /api/get-user-data?uid=danilozdravkovic-umpmo167
//
// Response (200):
//   {
//     found: true,
//     lookup_type: "code" | "email" | "uid",
//     data: { email, phone, llc_name, industry, state, owner_first, ... }
//   }
//
// Response (404):
//   { found: false, error: "code_not_found" | "email_not_found" | "uid_not_found" }
//
// Response (400):
//   { found: false, error: "invalid_code_format" | "invalid_email_format" | "invalid_uid_format" | "missing_param" }
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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUidFormat(uid) {
  // Expected format: imeprezime-XXXXXXXX (slug + unique_id, no llcNN suffix)
  return /^[a-z0-9]+-[a-z0-9]{6,12}$/i.test(uid);
}

function parseUid(uid) {
  // Split on LAST hyphen — slug can contain hyphens technically, but generator uses
  // slugifyName which strips them. Still, last-hyphen split is safest.
  const idx = uid.lastIndexOf('-');
  if (idx === -1) return null;
  return {
    slug: uid.substring(0, idx),
    unique_id: uid.substring(idx + 1)
  };
}

function formatResponseData(row, matchedTier) {
  return {
    discount_tier: matchedTier,
    discount_slug: row.discount_slug || '',
    discount_unique_id: row.discount_unique_id || '',
    
    // All 3 tiers - needed by /start-2/ to re-send on paid submit
    // so that Make Onboarding scenario doesn't blank these fields in Supabase
    discount_code_10_internal: row.discount_code_10_internal || '',
    discount_code_20_internal: row.discount_code_20_internal || '',
    discount_code_30_internal: row.discount_code_30_internal || '',
    discount_code_10_display: row.discount_code_10_display || '',
    discount_code_20_display: row.discount_code_20_display || '',
    discount_code_30_display: row.discount_code_30_display || '',
    discount_url_10: row.discount_url_10 || '',
    discount_url_20: row.discount_url_20 || '',
    discount_url_30: row.discount_url_30 || '',
    
    email: row.email || '',
    phone: row.phone || '',
    phone_dial_code: row.phone_dial_code || '',
    phone_local: row.phone_local || '',
    phone_country_code: row.phone_country_code || '',
    
    first_name: row.first_name || '',
    last_name: row.last_name || '',
    full_name: row.full_name || '',
    
    llc_name: row.llc_name || '',
    llc_name_full: row.llc_name_full || '',
    
    industry: row.industry || '',
    industry_label: row.industry_label || '',
    
    registration_state: row.registration_state || '',
    registration_state_label: row.registration_state_label || '',
    
    address_street: row.address_street || '',
    address_city: row.address_city || '',
    address_postal: row.address_postal || '',
    address_country: row.address_country || '',
    address_country_code: row.address_country_code || '',
    
    selected_plan: row.selected_plan || '',
    selected_plan_label: row.selected_plan_label || '',
    selected_price: row.selected_price || '',
    
    session_id: row.session_id || ''
  };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  if (req.method !== 'GET') {
    return res.status(405).json({ found: false, error: 'method_not_allowed' });
  }
  
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).json({ found: false, error: 'server_misconfigured' });
  }
  
  const rawCode = (req.query.code || '').trim().toLowerCase();
  const rawEmail = (req.query.email || '').trim().toLowerCase();
  const rawUid = (req.query.uid || '').trim().toLowerCase();
  
  if (!rawCode && !rawEmail && !rawUid) {
    return res.status(400).json({ found: false, error: 'missing_param', details: 'Provide ?code=, ?email= or ?uid=' });
  }
  
  let queryUrl;
  let lookupType;
  
  if (rawCode) {
    // === LOOKUP BY DISCOUNT CODE (used by /start-2) ===
    if (!isValidCodeFormat(rawCode)) {
      return res.status(400).json({ found: false, error: 'invalid_code_format' });
    }
    
    const orFilter = [
      `discount_code_10_internal.eq.${rawCode}`,
      `discount_code_20_internal.eq.${rawCode}`,
      `discount_code_30_internal.eq.${rawCode}`
    ].join(',');
    
    queryUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?or=(${orFilter})&limit=1`;
    lookupType = 'code';
  } else if (rawUid) {
    // === LOOKUP BY UID (used by /start-2a resume page) ===
    if (!isValidUidFormat(rawUid)) {
      return res.status(400).json({ found: false, error: 'invalid_uid_format' });
    }
    
    const parsed = parseUid(rawUid);
    if (!parsed) {
      return res.status(400).json({ found: false, error: 'invalid_uid_format' });
    }
    
    // Match on both discount_slug AND discount_unique_id (defense against guessing)
    queryUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`
      + `?discount_slug=eq.${encodeURIComponent(parsed.slug)}`
      + `&discount_unique_id=eq.${encodeURIComponent(parsed.unique_id)}`
      + `&limit=1`;
    lookupType = 'uid';
  } else {
    // === LOOKUP BY EMAIL (used by /onboarding) ===
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
      let errKey;
      if (lookupType === 'code') errKey = 'code_not_found';
      else if (lookupType === 'uid') errKey = 'uid_not_found';
      else errKey = 'email_not_found';
      return res.status(404).json({ found: false, error: errKey });
    }
    
    const row = rows[0];
    
    // For code lookup, determine which tier matched
    let matchedTier = null;
    if (lookupType === 'code') {
      if (row.discount_code_10_internal === rawCode) matchedTier = 10;
      else if (row.discount_code_20_internal === rawCode) matchedTier = 20;
      else if (row.discount_code_30_internal === rawCode) matchedTier = 30;
      
      // Check if this specific tier has been used already
      // (One-and-done: when any tier is used, all tiers' used_at are set)
      if (matchedTier) {
        const usedAtField = `code_${matchedTier}_used_at`;
        if (row[usedAtField]) {
          // Code has been used — return 410 Gone, no user data leaked
          return res.status(410).json({
            found: false,
            error: 'code_used',
            tier: matchedTier
          });
        }
        
        // Check if this tier (and the only allowed upgrade path) is expired
        // Allowed upgrade: 10 -> 20 (only)
        // Forbidden: 10 -> 30 (skip), 20 -> 30 (sales-team-only)
        // 30 never expires (code_30_expires_at is always NULL)
        const now = new Date();
        const isExpired = (tier) => {
          const exp = row[`code_${tier}_expires_at`];
          if (!exp) return false; // NULL = never expires
          return new Date(exp) < now;
        };
        
        if (matchedTier === 10) {
          // 10 expired AND 20 also expired → no valid upgrade path → expired popup
          // 10 expired AND 20 valid → return upgrade hint so frontend can update UI immediately
          // 10 valid → proceed normally
          if (isExpired(10) && isExpired(20)) {
            return res.status(410).json({
              found: false,
              error: 'code_expired',
              tier: matchedTier
            });
          }
          if (isExpired(10) && !isExpired(20)) {
            // Frontend should display 20% off immediately (auto-upgrade preview)
            // Backend create-payment-intent will still re-validate and apply 20% at payment time
            return res.status(200).json({
              found: true,
              lookup_type: lookupType,
              data: formatResponseData(row, matchedTier),
              upgrade_hint: {
                from_tier: 10,
                to_tier: 20,
                reason: 'tier_10_expired'
              }
            });
          }
        } else if (matchedTier === 20) {
          // 20 expired → no upgrade allowed (30 is sales-only)
          if (isExpired(20)) {
            return res.status(410).json({
              found: false,
              error: 'code_expired',
              tier: matchedTier
            });
          }
        }
        // matchedTier === 30 → never expires, always valid (if not used)
      }
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
