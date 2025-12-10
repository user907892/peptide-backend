const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ORIGIN || '*' }));

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️ STRIPE_SECRET_KEY is not set. Set it in your 
environment.');
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// Map your frontend product ids to Stripe Price IDs (provided by you)
const PRICE_MAP = {
  "semax-10mg": "price_1ScasMBb4lHMkptr4I8lR9wk",
  "semaglutide-10mg": "price_1ScartBb4lHMkptrnPNzWGlE",
  "cjc-1295-dac-10mg": "price_1ScarOBb4lHMkptrAMf8k9xA",
  "cjc-1295-no-dac-5mg": "price_1ScaqtBb4lHMkptrhqHvm4hg",
  "sermorelin-5mg": "price_1ScaqNBb4lHMkptrzUczdGLz",
  "melanotan-ii-10mg": "price_1Scaq2Bb4lHMkptr0tZIa7ze",
  "bpc-157-5mg": "price_1ScapUBb4lHMkptrax7jYKP9",
  "ghk-cu-50mg": "price_1ScaoTBb4lHMkptrCL7aXtc7",
  "retatrutide-20mg": "price_1ScanwBb4lHMkptrMgFVPecU",
  "tirzepatide-10mg": "price_1ScanFBb4lHMkptrVBOBoRdc",
};

app.get('/', (req, res) => {
  res.send('ArcticLabSupply Stripe backend is running.');
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items } = req.body;
    console.log('Incoming checkout body:', JSON.stringify(req.body));

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided. Cart is 
empty or invalid.' });
    }

    // Build Stripe line_items. Accepts either:
    // { price: 'price_xxx', quantity } OR { priceId: 'price_xxx', 
quantity }
    // OR frontend product id: { id: 'retatrutide-20mg', quantity } which 
is mapped via PRICE_MAP.
    const line_items = items.map((item, index) => {
      const priceId = item.price || item.priceId || (item.id && 
PRICE_MAP[item.id]);
      if (!priceId) {
        throw new Error(`Missing price/priceId and unknown product id for 
item at index ${index}. Item: ${JSON.stringify(item)}`);
      }
      const quantity = Number(item.quantity || item.qty) > 0 ? 
Number(item.quantity || item.qty) : 1;
      return { price: priceId, quantity };
    });

    console.log('Creating Stripe session with line_items:', 
JSON.stringify(line_items));

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: 
'https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://arcticlabsupply.com/cart',
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['US'] },
      automatic_tax: { enabled: false },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({
      error: err.message || 'Internal server error creating Stripe 
session.',
    });
  }
});

const PORT = Number(process.env.PORT || 4242);
app.listen(PORT, () => {
  console.log('Stripe backend running on port ' + PORT);
});
