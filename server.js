const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// parse JSON for normal endpoints
app.use(express.json());

// configure CORS (change ORIGIN in .env to restrict)
const CORS_ORIGIN = process.env.ORIGIN || '*';
app.use(cors({ origin: CORS_ORIGIN }));

// Stripe initialization (reads secret from .env)
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️ STRIPE_SECRET_KEY is not set. Set it in your 
environment.');
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// Server-side mapping from possible frontend product ids -> Stripe 
price_xxx ids
// Includes common variants/typos so your live frontend ids are accepted 
without changes.
const PRICE_MAP = {
  // Semax
  "semax-10mg": "price_1ScasMBb4lHMkptr4I8lR9wk",
  "Semax10mg-80": "price_1ScasMBb4lHMkptr4I8lR9wk",
  "semax10mg": "price_1ScasMBb4lHMkptr4I8lR9wk",

  // Semaglutide
  "semaglutide-10mg": "price_1ScartBb4lHMkptrnPNzWGlE",
  "Segmaglutide10mg-129": "price_1ScartBb4lHMkptrnPNzWGlE",
  "semaglutide10mg": "price_1ScartBb4lHMkptrnPNzWGlE",

  // CJC-1295 with DAC
  "cjc-1295-dac-10mg": "price_1ScarOBb4lHMkptrAMf8k9xA",
  "Cjc-1295withdac-139": "price_1ScarOBb4lHMkptrAMf8k9xA",

  // CJC-1295 no DAC
  "cjc-1295-no-dac-5mg": "price_1ScaqtBb4lHMkptrhqHvm4hg",
  "Cjc-1295nodac5mg-75": "price_1ScaqtBb4lHMkptrhqHvm4hg",

  // Sermorelin
  "sermorelin-5mg": "price_1ScaqNBb4lHMkptrzUczdGLz",
  "Sermorelin5mg-79": "price_1ScaqNBb4lHMkptrzUczdGLz",

  // Melanotan II
  "melanotan-ii-10mg": "price_1Scaq2Bb4lHMkptr0tZIa7ze",
  "Melanotanll10mg-75": "price_1Scaq2Bb4lHMkptr0tZIa7ze",
  "melanotan10mg": "price_1Scaq2Bb4lHMkptr0tZIa7ze",

  // BPC-157
  "bpc-157-5mg": "price_1ScapUBb4lHMkptrax7jYKP9",
  "Bpc-157 5mg-79": "price_1ScapUBb4lHMkptrax7jYKP9",
  "bpc-157": "price_1ScapUBb4lHMkptrax7jYKP9",

  // GHK-Cu
  "ghk-cu-50mg": "price_1ScaoTBb4lHMkptrCL7aXtc7",
  "Ghk-cu50mg-60": "price_1ScaoTBb4lHMkptrCL7aXtc7",
  "ghkcu50mg": "price_1ScaoTBb4lHMkptrCL7aXtc7",

  // Retatrutide
  "retatrutide-20mg": "price_1ScanwBb4lHMkptrMgFVPecU",
  "Retatrutide20mg-149": "price_1ScanwBb4lHMkptrMgFVPecU",
  "retatrutide": "price_1ScanwBb4lHMkptrMgFVPecU",

  // Tirzepatide
  "tirzepatide-10mg": "price_1ScanFBb4lHMkptrVBOBoRdc",
  "Trizeputide-ruo10mg-95": "price_1ScanFBb4lHMkptrVBOBoRdc",
  "trizeputide": "price_1ScanFBb4lHMkptrVBOBoRdc",
};

// simple health-check
app.get('/', (req, res) => res.send('Stripe backend (cart-based) is up'));

// expose publishable key if frontend needs it
app.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

/*
  create-checkout-session
  Accepts body:
  {
    orderId?: string,
    customer: { name?: string, email: string, phone?: string },
    items: [
      { price: "price_xxx", quantity } OR
      { priceId: "price_xxx", quantity } OR
      { id: "retatrutide-20mg", qty: 1 } // mapped via PRICE_MAP
    ],
    coupon?: string|null
  }
*/
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { orderId = '', customer = {}, items = [], coupon = null } = 
req.body;

    console.log('Incoming checkout body:', JSON.stringify(req.body));

    if (!customer || !customer.email) {
      return res.status(400).json({ error: 'Customer email is required' 
});
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty or invalid' });
    }

    // Build Stripe line_items (accept price/priceId or map id -> price 
via PRICE_MAP)
    const line_items = items.map((it, idx) => {
      const quantity = Number(it.quantity ?? it.qty) > 0 ? 
Number(it.quantity ?? it.qty) : 1;
      const priceId = it.price || it.priceId || (it.id && 
PRICE_MAP[it.id]);

      if (!priceId) {
        throw new Error(`Missing price/priceId and unknown product id for 
item index ${idx}: ${JSON.stringify(it)}`);
      }

      return { price: priceId, quantity };
    });

    console.log('Resolved line_items:', JSON.stringify(line_items));

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      customer_email: customer.email,
      metadata: {
        order_id: orderId,
        items: JSON.stringify(items),
        coupon: coupon || '',
      },
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      success_url: (process.env.ORIGIN || 'https://arcticlabsupply.com') + 
'/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.ORIGIN || 'https://arcticlabsupply.com') + 
'/cart',
      automatic_tax: { enabled: false },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res.status(500).json({ error: err.message || 'Internal server 
error creating session' });
  }
});

/*
  Webhook endpoint
  - If STRIPE_WEBHOOK_SECRET is set the server verifies signatures.
  - If not set it will parse JSON directly (dev convenience only).
*/
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, 
res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, 
webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook error: signature verification failed or invalid 
payload', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('Webhook: checkout.session.completed', { id: session.id, 
metadata: session.metadata });
      // TODO: mark order paid in DB using session.metadata.order_id
      break;
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log('Webhook: payment_intent.succeeded', pi.id);
      break;
    }
    default:
      console.log('Webhook: unhandled event type', event.type);
  }

  res.json({ received: true });
});

// start server
const PORT = Number(process.env.PORT || 4242);
app.listen(PORT, () => {
  console.log(`Stripe backend listening on http://localhost:${PORT}`);
});
