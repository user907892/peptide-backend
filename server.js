// server.js

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Stripe secret key from environment (Render / local)
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ STRIPE_SECRET_KEY is not set. Set it in your Render env 
vars.");
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ✅ Health check
app.get("/", (req, res) => {
  res.send("ArcticLabSupply Stripe backend is running.");
});

// ✅ Create Checkout Session
// Your frontend sends:
// { items: [ { price: 'price_xxx', quantity: 2 }, ... ] }
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body;

    console.log("Incoming checkout body:", req.body);

    // Basic validation
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "No items provided. Cart is empty or invalid." });
    }

    // Map frontend items → Stripe line_items
    const line_items = items.map((item, index) => {
      // Frontend sends { price: p.stripePriceId, quantity }
      // but we'll also accept priceId just in case.
      const priceId = item.price || item.priceId;

      if (!priceId) {
        throw new Error(
          `Missing price / priceId for item at index ${index}. Got: 
${JSON.stringify(
            item
          )}`
        );
      }

      const quantity = Number(item.quantity) > 0 ? Number(item.quantity) : 
1;

      return {
        price: priceId,
        quantity,
      };
    });

    console.log("Creating Stripe session with line_items:", line_items);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url:
        
"https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://arcticlabsupply.com/cart",
      billing_address_collection: "required",
      shipping_address_collection: {
        allowed_countries: ["US"],
      },
      automatic_tax: { enabled: false },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    return res.status(500).json({
      error: err.message || "Internal server error creating Stripe 
session.",
    });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log("Stripe backend running on port " + PORT);
});

