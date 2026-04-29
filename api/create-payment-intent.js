// /api/create-payment-intent.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Plan prices in cents (EUR)
const PLAN_PRICES = {
  starter: 39900,  // €399.00
  growth:  49900   // €499.00
};

const PLAN_LABELS = {
  starter: 'Get Started LLC (€399)',
  growth:  'Growth-Ready LLC (€499)'
};

export default async function handler(req, res) {
  // CORS headers - dozvoli pozive sa GitHub Pages domena
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { plan, session_id, llc_name, email, full_name, registration_state } = req.body;
    
    // Validacija plana
    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    // Validacija osnovnih podataka
    if (!email || !llc_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const amount = PLAN_PRICES[plan];
    
    // Kreiraj PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      receipt_email: email,
      description: `Formio.biz - ${PLAN_LABELS[plan]} - ${llc_name}`,
      metadata: {
        session_id: session_id || '',
        llc_name: llc_name || '',
        email: email || '',
        full_name: full_name || '',
        plan: plan,
        plan_label: PLAN_LABELS[plan],
        registration_state: registration_state || '',
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
