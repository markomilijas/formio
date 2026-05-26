// /api/create-payment-intent.js
// Updated to support discount codes with Supabase validation
//   - Validates discount code format
//   - Looks up code in Supabase
//   - Checks expires_at and used_at
//   - Auto-upgrades to next tier if code expired
//   - Applies server-side discount calculation (Stripe Payment Intents API doesn't support Coupons directly)
//
// CHANGE (May 2026): receipt_email REMOVED.
//   Stripe now uses billing_details.email from Payment Element (what user enters
//   on checkout) for receipts. This means if user changes email at checkout,
//   receipt + billing communications go to new email.
//   metadata.email + metadata.full_name remain as "form-submitted" audit values.
 
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_TABLE = 'start_partial_submissions';

// Base prices in cents (Wyoming = base, no surcharge) - in USD
const BASE_PRICES = {
  starter: 46900,  // $469.00
  growth:  54900   // $549.00
};

// State surcharges in cents - in USD
const STATE_SURCHARGES = {
  wyoming:  0,      // base
  delaware: 11500   // +$115
};

const PLAN_LABELS = {
  starter: 'Get Started LLC',
  growth:  'Growth-Ready LLC'
};

const STATE_LABELS = {
  wyoming:  'Wyoming',
  delaware: 'Delaware'
};

function calculateBaseAmount(plan, state) {
  const base = BASE_PRICES[plan];
  const surcharge = STATE_SURCHARGES[state] || 0;
  return base + surcharge;
}

// Apply percentage discount using Math.floor (rounds down, matches frontend display)
function applyPercentDiscount(amountCents, percent) {
  const discountedDollars = Math.floor((amountCents / 100) * (1 - percent / 100));
  return discountedDollars * 100;
}

// Validate discount code format: imeprezime-XXXXXXXX-llcNN
function isValidCodeFormat(code) {
  return /^[a-z0-9]+-[a-z0-9]{6,12}-llc(10|20|30)$/i.test(code || '');
}

// Parse tier from code
function parseTier(code) {
  const m = (code || '').match(/-llc(10|20|30)$/i);
  return m ? parseInt(m[1], 10) : null;
}

// Query Supabase for the code, with auto-upgrade if expired
// Returns: { valid: true, tier: 20, row: {...} } or { valid: false, reason: "..." }
async function validateDiscountCode(code) {
  if (!isValidCodeFormat(code)) {
    return { valid: false, reason: 'invalid_format' };
  }
  
  const codeNormalized = code.toLowerCase();
  
  // Query Supabase via PostgREST API
  const orFilter = [
    `discount_code_10_internal.eq.${codeNormalized}`,
    `discount_code_20_internal.eq.${codeNormalized}`,
    `discount_code_30_internal.eq.${codeNormalized}`
  ].join(',');
  
  const queryUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?or=(${orFilter})&limit=1`;
  
  let supabaseResponse;
  try {
    supabaseResponse = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Accept': 'application/json'
      }
    });
  } catch (err) {
    console.error('Supabase fetch error:', err);
    return { valid: false, reason: 'supabase_unreachable' };
  }
  
  if (!supabaseResponse.ok) {
    const errText = await supabaseResponse.text();
    console.error('Supabase non-OK:', supabaseResponse.status, errText);
    return { valid: false, reason: 'supabase_error' };
  }
  
  const rows = await supabaseResponse.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { valid: false, reason: 'code_not_found' };
  }
  
  const row = rows[0];
  
  // Determine which tier the user clicked
  let requestedTier = null;
  if (row.discount_code_10_internal === codeNormalized) requestedTier = 10;
  else if (row.discount_code_20_internal === codeNormalized) requestedTier = 20;
  else if (row.discount_code_30_internal === codeNormalized) requestedTier = 30;
  
  if (!requestedTier) {
    return { valid: false, reason: 'tier_mismatch' };
  }
  
  const now = new Date();
  
  // Helper: check if a specific tier is currently valid (not expired, not used)
  function tierIsValid(tier) {
    const expiresAt = row[`code_${tier}_expires_at`];
    const usedAt = row[`code_${tier}_used_at`];
    
    if (usedAt) return { ok: false, reason: 'used' };
    if (expiresAt) {
      const exp = new Date(expiresAt);
      if (exp < now) return { ok: false, reason: 'expired' };
    }
    return { ok: true };
  }
  
  // Check requested tier
  const requestedCheck = tierIsValid(requestedTier);
  if (requestedCheck.ok) {
    // Use requested tier
    return {
      valid: true,
      tier: requestedTier,
      upgraded: false,
      row: row,
      code: row[`discount_code_${requestedTier}_internal`]
    };
  }
  
  // If requested tier is expired/used, try to upgrade
  // 10 -> 20 -> 30
  if (requestedTier === 10) {
    const check20 = tierIsValid(20);
    if (check20.ok) {
      return {
        valid: true,
        tier: 20,
        upgraded: true,
        upgraded_from: 10,
        row: row,
        code: row.discount_code_20_internal
      };
    }
    const check30 = tierIsValid(30);
    if (check30.ok) {
      return {
        valid: true,
        tier: 30,
        upgraded: true,
        upgraded_from: 10,
        row: row,
        code: row.discount_code_30_internal
      };
    }
  }
  
  if (requestedTier === 20) {
    const check30 = tierIsValid(30);
    if (check30.ok) {
      return {
        valid: true,
        tier: 30,
        upgraded: true,
        upgraded_from: 20,
        row: row,
        code: row.discount_code_30_internal
      };
    }
  }
  
  // No valid tier found
  return {
    valid: false,
    reason: requestedCheck.reason || 'all_tiers_unavailable'
  };
}

export default async function handler(req, res) {
  // CORS
  const allowedOrigins = [
    'https://formio.biz',
    'https://www.formio.biz',
    'https://markomilijas.github.io'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const {
      plan,
      session_id,
      llc_name,
      email,
      full_name,
      registration_state,
      discount_code,
      discount_tier  // Frontend hint, but we re-validate from Supabase
    } = req.body;
    
    // Plan validation
    if (!plan || !BASE_PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    // State validation
    if (!registration_state || !(registration_state in STATE_SURCHARGES)) {
      return res.status(400).json({ error: 'Invalid registration state. Must be wyoming or delaware.' });
    }
    
    // Required fields validation
    if (!email || !llc_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Calculate base amount based on plan + state
    let amount = calculateBaseAmount(plan, registration_state);
    const planLabel = PLAN_LABELS[plan];
    const stateLabel = STATE_LABELS[registration_state];
    
    // === DISCOUNT VALIDATION & APPLICATION ===
    let appliedDiscount = null;
    
    if (discount_code) {
      // Validate code in Supabase
      const validation = await validateDiscountCode(discount_code);
      
      if (validation.valid) {
        const tierPercent = validation.tier;  // 10, 20, or 30
        const originalAmount = amount;
        amount = applyPercentDiscount(amount, tierPercent);
        appliedDiscount = {
          tier: tierPercent,
          code: validation.code,
          original_amount_cents: originalAmount,
          discount_amount_cents: originalAmount - amount,
          upgraded: validation.upgraded || false,
          upgraded_from: validation.upgraded_from || null,
          supabase_row_id: validation.row.id
        };
        console.log('Discount applied:', appliedDiscount);
      } else {
        console.warn('Discount validation failed:', validation.reason, 'code:', discount_code);
        // If discount fails, charge full price (don't fail the whole payment)
      }
    }
    
    const amountUsd = (amount / 100).toFixed(0);
    const fullPlanLabel = `${planLabel} (${stateLabel}) - $${amountUsd}`;
    
    // Build metadata
    // NOTE: email/full_name here are "form-submitted" values (from Step 5 modal or
    // populateFormFromUserData). These are kept for audit. The actual billing email/phone
    // that the user enters in the Stripe Payment Element will be in
    // charges.data[0].billing_details.* on the webhook event.
    const metadata = {
      session_id: session_id || '',
      llc_name: llc_name || '',
      email: email || '',                  // form email (audit)
      full_name: full_name || '',          // form name (audit)
      plan: plan,
      plan_label: planLabel,
      registration_state: registration_state,
      registration_state_label: stateLabel,
      amount_usd: amountUsd,
      source: 'formio.biz'
    };
    
    // Add discount metadata if applied
    if (appliedDiscount) {
      metadata.discount_applied = 'true';
      metadata.discount_tier = String(appliedDiscount.tier);
      metadata.discount_code = appliedDiscount.code || '';
      metadata.discount_amount_usd = String(Math.floor(appliedDiscount.discount_amount_cents / 100));
      metadata.discount_original_usd = String(Math.floor(appliedDiscount.original_amount_cents / 100));
      if (appliedDiscount.upgraded) {
        metadata.discount_upgraded_from = String(appliedDiscount.upgraded_from);
      }
      metadata.supabase_row_id = appliedDiscount.supabase_row_id || '';
    } else {
      metadata.discount_applied = 'false';
    }
     
    // Create PaymentIntent
    // IMPORTANT: receipt_email is NOT set here.
    // Stripe will automatically use billing_details.email from the Payment Element
    // (what user enters/edits on checkout) to send the receipt. This is the desired
    // behavior — if user changes email on checkout, receipt goes to new address.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      description: `Formio.biz - ${fullPlanLabel} - ${llc_name}`,
      metadata: metadata
    });
    
    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      amount: amount,
      discount: appliedDiscount  // Inform frontend about applied discount
    });
    
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
}
