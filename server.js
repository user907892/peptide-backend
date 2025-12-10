// server.js
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();

// ✅ Middleware
app.use(cors()); // if you want to lock this down later, we can
app.use(express.json());

// ✅ Stripe secret key (set this in Render / env, DO NOT hardcode)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Simple healthcheck
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "ArcticLabSupply backend live" });
});

/**
 * POST /create-checkout-session
 *
 * Expects JSON body:
 * {
 *   items: [{ id: "price_XXX", quantity: 1 }, ...],
 *   shipping: 6.95   // optional, number in dollars
 * }
 *
 * IMPORTANT:
 * - `id` from the frontend MUST be a Stripe Price ID (e.g. 
"price_1ScBFW...")
 *   This matches how your cart currently works if your FEATURED ids are 
price IDs.
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items, shipping } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const line_items = [];

    // 🔹 Build product line items directly from price IDs sent by 
frontend
    for (const item of items) {
      if (!item.id) continue;

      line_items.push({
        price: item.id,                // <-- assumes item.id is a Stripe 
PRICE ID
        quantity: item.quantity || 1,
      });
    }

    // 🔹 Add shipping line item if provided and > 0
    if (typeof shipping === "number" && shipping > 0) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Shipping",
          },
          unit_amount: Math.round(shipping * 100), // dollars → cents
        },
        quantity: 1,
      });
    }

    if (line_items.length === 0) {
      return res.status(400).json({ error: "No valid line items" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://arcticlabsupply.com/success",
      cancel_url: "https://arcticlabsupply.com/cart",

      // ✅ Force Stripe to collect SHIPPING ADDRESS
      shipping_address_collection: {
        allowed_countries: ["US"], // expand if you ship elsewhere
      },

      // Optional, but nice to have phone for delivery issues
      phone_number_collection: {
        enabled: true,
      },

      metadata: {
        source: "arcticlabsupply-cart",
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    return res.status(500).json({ error: "Failed to create checkout 
session" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`ArcticLabSupply backend listening on port ${PORT}`);
});

