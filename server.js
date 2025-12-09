const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Stripe will read the key from your environment variable
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Your Tirzepatide 10mg Price ID
const PRICE_ID = "price_1ScBFWPj0EAH4VA9BFmmDSEH";

// ✅ Match this to your Stripe price (in cents)
const UNIT_AMOUNT = 12900;

// ✅ Free shipping over $99, otherwise $6.95
function getShippingOptions(subtotalCents) {
  const FREE_THRESHOLD = 9900;
  const STANDARD_SHIP = 695;

  if (subtotalCents >= FREE_THRESHOLD) {
    return [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: 0, currency: "usd" },
          display_name: "Free Shipping ($99+)",
          delivery_estimate: {
            minimum: { unit: "business_day", value: 2 },
            maximum: { unit: "business_day", value: 5 },
          },
        },
      },
    ];
  }

  return [
    {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount: STANDARD_SHIP, currency: "usd" },
        display_name: "Standard Shipping",
        delivery_estimate: {
          minimum: { unit: "business_day", value: 2 },
          maximum: { unit: "business_day", value: 5 },
        },
      },
    },
  ];
}

// ✅ Checkout endpoint
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { quantity = 1 } = req.body;
    const subtotal = UNIT_AMOUNT * quantity;
    const shippingOptions = getShippingOptions(subtotal);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: PRICE_ID,
          quantity,
        },
      ],
      shipping_address_collection: {
        allowed_countries: ["US"],
      },
      shipping_options: shippingOptions,
      success_url: "http://localhost:5173/success",
      cancel_url: "http://localhost:5173/cancel",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


const port = process.env.PORT || 4242;

app.listen(port, () => {
  console.log(`Stripe backend running on port ${port}`);
});

