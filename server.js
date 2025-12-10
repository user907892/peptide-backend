const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Stripe secret key from environment (Render)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Default product: Tirzepatide-RUO 10mg
const DEFAULT_PRICE_ID = 'price_1ScanFBb4lHMkptrVBOBoRdc';

// Health check
app.get('/', (req, res) => {
  res.send('Arctic Lab backend is running.');
});

// Very simple checkout: single product, no shipping options
app.post('/create-checkout-session', async (req, res) => {
  try {
    const quantity = Number(req.body.quantity) || 1;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: DEFAULT_PRICE_ID,
          quantity: quantity
        }
      ],
      success_url: 
'https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://arcticlabsupply.com/cart'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log('Stripe backend running on port ' + PORT);
});


