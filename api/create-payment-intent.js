// /api/create-payment-intent.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Base prices in cents (Wyoming = base, no surcharge)
const BASE_PRICES = {
  starter: 39900,  // €399.00
  growth:  49900   // €499.00
};

// State surcharges in cents
const STATE_SURCHARGES = {
  wyoming:  0,      // base
  delaware: 10000   // +€100
};

const PLAN_LABELS = {
  starter: 'Get Started LLC',
  growth:  'Growth-Ready LLC'
};

const STATE_LABELS = {
  wyoming:  'Wyoming',
  delaware: 'Delaware'
};

function calculateAmount(plan, state) {
  const base = BASE_PRICES[plan];
  const surcharge = STATE_SURCHARGES[state] || 0;
  return base + surcharge;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { plan, session_id, llc_name, email, full_name, registration_state } = req.body;
    
    // Plan validation
    if (!plan || !BASE_PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    // State validation - mora biti 'wyoming' ili 'delaware'
    if (!registration_state || !(registration_state in STATE_SURCHARGES)) {
      return res.status(400).json({ error: 'Invalid registration state. Must be wyoming or delaware.' });
    }
    
    // Required fields validation
    if (!email || !llc_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Calculate final amount based on plan + state
    const amount = calculateAmount(plan, registration_state);
    const planLabel = PLAN_LABELS[plan];
    const stateLabel = STATE_LABELS[registration_state];
    const amountEur = (amount / 100).toFixed(0);
    const fullPlanLabel = `${planLabel} (${stateLabel}) - €${amountEur}`;
    
    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      receipt_email: email,
      description: `Formio.biz - ${fullPlanLabel} - ${llc_name}`,
      metadata: {
        session_id: session_id || '',
        llc_name: llc_name || '',
        email: email || '',
        full_name: full_name || '',
        plan: plan,
        plan_label: planLabel,
        registration_state: registration_state,
        registration_state_label: stateLabel,
        amount_eur: amountEur,
        source: 'formio.biz'
      }
    });
    
    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      amount: amount
    });
    
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
}
