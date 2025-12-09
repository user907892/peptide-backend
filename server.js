const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Stripe secret key from environment (Render / .env)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Default price for legacy single-product checkout (Tirzepatide 10mg)
const DEFAULT_PRICE_ID = "price_1ScBFWPj0EAH4VA9BFmmDSEH";

// Map: Stripe price ID -> { amount in cents, name shown in Checkout }
const priceInfo = {
  "price_1ScJgYPj0EAH4VA95T7gp8Az": {
    amount: 8000,
    name: "Semax 10mg",
  },
  "price_1ScJg4Pj0EAH4VA9bYR6w5tl": {
    amount: 12900,
    name: "Semaglutide 10mg",
  },
  "price_1ScJfXPj0EAH4VA9V7PpE9Eq": {
    amount: 13900,
    name: "CJC-1295 (with DAC) 10mg",
  },
  "price_1ScJewPj0EAH4VA9R9LhS2MF": {
    amount: 7500,
    name: "CJC-1295 (no DAC) 5mg",
  },
  "price_1ScJe8Pj0EAH4VA95VyIh4fw": {
    amount: 7900,
    name: "Sermorelin 5mg",
  },
  "price_1ScJdiPj0EAH4VA9kpUfG068": {
    amount: 7500,
    name: "Melanotan II 10mg",
  },
  "price_1ScJdBPj0EAH4VA9wfFVbFVD": {
    amount: 7900,
    name: "BPC-157 5mg",
  },
  "price_1ScJcXPj0EAH4VA99rlRDPa3": {
    amount: 6000,
    name: "GHK-Cu 50mg",
  },
  "price_1ScJc0Pj0EAH4VA9lOkFmXvG": {
    amount: 14900,
    name: "Retatrutide 20mg",
  },
  "price_1ScBFWPj0EAH4VA9BFmmDSEH": {
    amount: 9500,
    name: "Tirzepatide-RUO 10mg",
  },
};

// Free shipping over $99, otherwise $6.95
const FREE_THRESHOLD = 9900; // $99.00
const STANDARD_SHIP = 695;   // $6.95

function getShippingOptions(subtotalCents) {
  const deliveryEstimate = {
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
          delivery_estimate: deliveryEstimate,
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
        delivery_estimate: deliveryEstimate,
      },
    },
  ];
}

// Calculate subtotal from normalized items (using priceInfo)
function calculateSubtotalCents(normalizedItems) {
  let subtotal = 0;

  for (let i = 0; i < normalizedItems.length; i++) {
    const item = normalizedItems[i];
    const info = priceInfo[item.priceId];

    if (!info) {
      throw new Error("Unknown price ID in subtotal: " + item.priceId);
    }

    const qty = item.quantity || 1;
    subtotal += info.amount * qty;
  }

  return subtotal;
}

// Simple health check
app.get("/", function (req, res) {
  res.send("Arctic Lab backend is running.");
});

// Checkout endpoint
app.post("/create-checkout-session", async function (req, res) {
  try {
    let normalizedItems = [];

    // New style: { items: [{ price, quantity }, ...] }
    if (Array.isArray(req.body.items) && req.body.items.length > 0) {
      normalizedItems = req.body.items.map(function (item) {
        return {
          priceId: item.price,
          quantity: item.quantity || 1,
        };
      });
    } else {
      // Legacy: { quantity } => falls back to default single product
      const quantity = req.body.quantity || 1;
      normalizedItems = [
        {
          priceId: DEFAULT_PRICE_ID,
          quantity: quantity,
        },
      ];
    }

    console.log("Normalized items:", JSON.stringify(normalizedItems));

    const subtotal = calculateSubtotalCents(normalizedItems);
    const shippingOptions = getShippingOptions(subtotal);

    // Build line_items with price_data so we control names/prices
    const stripeLineItems = normalizedItems.map(function (item) {
      const info = priceInfo[item.priceId];
      if (!info) {
        throw new Error("Unknown price ID in line item: " + item.priceId);
      }

      return {
        quantity: item.quantity,
        price_data: {
          currency: "usd",
          unit_amount: info.amount,
          product_data: {
            name: info.name, // this is what shows in Stripe Checkout
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
      // TODO: change these URLs to your real frontend domain when live
      success_url: "http://localhost:5173/success",
      cancel_url: "http://localhost:5173/cancel",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    if (err && err.message && err.message.indexOf("Unknown price ID") === 
0) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

const port = process.env.PORT || 4242;

app.listen(port, function () {
  console.log("Stripe backend running on port " + port);
});


