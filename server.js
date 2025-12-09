
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Stripe secret key from environment (Render / local .env)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Default product (for your existing single-product checkout fallback)
// This is your Trizeputide RUO 10mg
const DEFAULT_PRICE_ID = "price_1ScBFWPj0EAH4VA9BFmmDSEH";

// ✅ Map of ALL Stripe Price IDs -> amount in cents
// (based on the list you gave me)
const priceMap = {
  "price_1ScJgYPj0EAH4VA95T7gp8Az": 8000,   // Semax 10mg - $80
  "price_1ScJg4Pj0EAH4VA9bYR6w5tl": 12900,  // Semaglutide 10mg - $129
  "price_1ScJfXPj0EAH4VA9V7PpE9Eq": 13900,  // CJC-1295 with DAC - $139
  "price_1ScJewPj0EAH4VA9R9LhS2MF": 7500,   // CJC-1295 no DAC 5mg - $75
  "price_1ScJe8Pj0EAH4VA95VyIh4fw": 7900,   // Sermorelin 5mg - $79
  "price_1ScJdiPj0EAH4VA9kpUfG068": 7500,   // Melanotan II 10mg - $75
  "price_1ScJdBPj0EAH4VA9wfFVbFVD": 7900,   // BPC-157 5mg - $79
  "price_1ScJcXPj0EAH4VA99rlRDPa3": 6000,   // GHK-CU 50mg - $60
  "price_1ScJc0Pj0EAH4VA9lOkFmXvG": 14900,  // Retatrutide 20mg - $149
  "price_1ScBFWPj0EAH4VA9BFmmDSEH": 9500,   // Trizeputide RUO 10mg - $95
};

// ✅ Free shipping over $99, otherwise $6.95
const FREE_THRESHOLD = 9900; // $99.00
const STANDARD_SHIP = 695;   // $6.95

// ✅ 5–7 business day shipping estimate
function getShippingOptions(subtotalCents) {
  const delivery_estimate = {
    minimum: { unit: "business_day", value: 5 },
    maximum: { unit: "business_day", value: 7 },
  };

  if (subtotalCents >= FREE_THRESHOLD) {
    return [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: 0, currency: "usd" },
          display_name: "Free Shipping ($99+)",
          delivery_estimate,
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
        delivery_estimate,
      },
    },
  ];
}

// ✅ Helper: calculate subtotal in cents from line items
function calculateSubtotalCents(lineItems) {
  let subtotal = 0;

  for (const item of lineItems) {
    const unitAmount = priceMap[item.price];
    if (!unitAmount) {
      throw new Error(`Unknown price ID: ${item.price}`);
    }
    const qty = item.quantity || 1;
    subtotal += unitAmount * qty;
  }

  return subtotal;
}

// ✅ Checkout endpoint
app.post("/create-checkout-session", async (req, res) => {
  try {
    let lineItems = [];

    // 🛒 Case 1: New style – expects an array of items: [{ price, 
quantity }, ...]
    if (Array.isArray(req.body.items) && req.body.items.length > 0) {
      lineItems = req.body.items.map((item) => ({
        price: item.price,
        quantity: item.quantity || 1,
      }));
    } else {
      // 🧍‍♂️ Case 2: Backwards-compatible – your old single-product flow
      // Body like: { quantity: 1 }
      const quantity = req.body.quantity || 1;
      lineItems = [
        {
          price: DEFAULT_PRICE_ID,
          quantity,
        },
      ];
    }

    // 🧮 Subtotal in cents (for free shipping logic)
    const subtotal = calculateSubtotalCents(lineItems);

    // 📦 Shipping options based on subtotal (free over $99, 5–7 days)
    const shippingOptions = getShippingOptions(subtotal);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      shipping_address_collection: {
        allowed_countries: ["US"],
      },
      shipping_options: shippingOptions,
      // ⬇️ replace localhost with your real domain in production
      success_url: "http://localhost:5173/success",
      cancel_url: "http://localhost:5173/cancel",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err.message);
    if (err.message && err.message.startsWith("Unknown price ID")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

const port = process.env.PORT || 4242;

app.listen(port, () => {
  console.log(`Stripe backend running on port ${port}`);
});



