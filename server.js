const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Stripe secret key from environment (Render / local .env)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Default product (fallback if frontend sends only quantity)
const DEFAULT_PRICE_ID = "price_1ScBFWPj0EAH4VA9BFmmDSEH"; // Trizeputide 
RUO 10mg

// ✅ Central map: Stripe price ID -> { amount in cents, label for 
Checkout }
const priceInfo = {
  "price_1ScJgYPj0EAH4VA95T7gp8Az": {
    amount: 8000,
    name: "Semax 10mg",
  }, // $80

  "price_1ScJg4Pj0EAH4VA9bYR6w5tl": {
    amount: 12900,
    name: "Semaglutide 10mg",
  }, // $129

  "price_1ScJfXPj0EAH4VA9V7PpE9Eq": {
    amount: 13900,
    name: "CJC-1295 (with DAC) 10mg",
  }, // $139

  "price_1ScJewPj0EAH4VA9R9LhS2MF": {
    amount: 7500,
    name: "CJC-1295 (no DAC) 5mg",
  }, // $75

  "price_1ScJe8Pj0EAH4VA95VyIh4fw": {
    amount: 7900,
    name: "Sermorelin 5mg",
  }, // $79

  "price_1ScJdiPj0EAH4VA9kpUfG068": {
    amount: 7500,
    name: "Melanotan II 10mg",
  }, // $75

  "price_1ScJdBPj0EAH4VA9wfFVbFVD": {
    amount: 7900,
    name: "BPC-157 5mg",
  }, // $79

  "price_1ScJcXPj0EAH4VA99rlRDPa3": {
    amount: 6000,
    name: "GHK-Cu 50mg",
  }, // $60

  "price_1ScJc0Pj0EAH4VA9lOkFmXvG": {
    amount: 14900,
    name: "Retatrutide 20mg",
  }, // $149

  "price_1ScBFWPj0EAH4VA9BFmmDSEH": {
    amount: 9500,
    name: "Tirzepatide-RUO 10mg",
  }, // $95
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

// ✅ Helper: calculate subtotal in cents from our normalized items
function calculateSubtotalCents(normalizedItems) {
  let subtotal = 0;
  for (const item of normalizedItems) {
    const info = priceInfo[item.priceId];
    if (!info) {
      throw new Error(`Unknown price ID in subtotal: ${item.priceId}`);
    }
    const qty = item.quantity || 1;
    subtotal += info.amount * qty;
  }
  return subtotal;
}

// ✅ Checkout endpoint
app.post("/create-checkout-session", async (req, res) => {
  try {
    let normalizedItems = [];

    // 🛒 Case 1: New style – frontend sends: { items: [{ price, quantity 
}, ...] }
    if (Array.isArray(req.body.items) && req.body.items.length > 0) {
      normalizedItems = req.body.items.map((item) => ({
        priceId: item.price,
        quantity: item.quantity || 1,
      }));
    } else {
      // 🧍‍♂️ Case 2: Fallback – old flow with { quantity }
      const quantity = req.body.quantity || 1;
      normalizedItems = [
        {
          priceId: DEFAULT_PRICE_ID,
          quantity,
        },
      ];
    }

    // 🧮 Subtotal (for free shipping logic)
    const subtotal = calculateSubtotalCents(normalizedItems);
    const shippingOptions = getShippingOptions(subtotal);

    // 🔁 Build Stripe line_items using price_data so WE control the name 
& amount
    const stripeLineItems = normalizedItems.map((item) => {
      const info = priceInfo[item.priceId];
      if (!info) {
        throw new Error(`Unknown price ID in line item: ${item.priceId}`);
      }
      return {
        quantity: item.quantity,
        price_data: {
          currency: "usd",
          unit_amount: info.amount,
          product_data: {
            name: info.name, // 👈 THIS is what shows in Checkout
          },
        },
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: stripeLineItems,
      shipping_address_collection: {
        allowed_countries: ["US"],
      },
      shipping_options: shippingOptions,
      // ⬇️ change to your real domain when you deploy frontend
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

