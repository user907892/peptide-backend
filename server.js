// server.js

require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();

// ----- Stripe init -----
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ STRIPE_SECRET_KEY is not set. Stripe calls will 
fail.");
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ----- Frontend URL (where Stripe sends users back) -----
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://arcticlabsupply.com";

// ----- CORS -----
/**
 * On Render, set ORIGIN in the env like:
 *
 * 
https://arcticlabsupply.com,https://arcticlabsupply.netlify.app,http://localhost:5173
 */
const allowedOrigins =
  (process.env.ORIGIN && process.env.ORIGIN.split(",")) || [
    "http://localhost:5173",
    "https://arcticlabsupply.com",
    "https://arcticlabsupply.netlify.app",
  ];

app.use(express.json());

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (curl, Postman, Stripe webhooks etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("❌ CORS blocked for origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);

// ----- Product -> Price ID map (for Stripe) -----
const PRICE_MAP = {
  // Semax
  "semax-10mg": "price_1ScasMBb4lHMkptr4I8lR9wk",
  "Semax10mg-80": "price_1ScasMBb4lHMkptr4I8lR9wk",
  semax10mg: "price_1ScasMBb4lHMkptr4I8lR9wk",

  // Semaglutide
  "semaglutide-10mg": "price_1ScartBb4lHMkptrnPNzWGlE",
  "Segmaglutide10mg-129": "price_1ScartBb4lHMkptrnPNzWGlE",
  semaglutide10mg: "price_1ScartBb4lHMkptrnPNzWGlE",

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
  melanotan10mg: "price_1Scaq2Bb4lHMkptr0tZIa7ze",

  // BPC-157
  "bpc-157-5mg": "price_1ScapUBb4lHMkptrax7jYKP9",
  "Bpc-157 5mg-79": "price_1ScapUBb4lHMkptrax7jYKP9",
  "bpc-157": "price_1ScapUBb4lHMkptrax7jYKP9",

  // GHK-Cu
  "ghk-cu-50mg": "price_1ScaoTBb4lHMkptrCL7aXtc7",
  "Ghk-cu50mg-60": "price_1ScaoTBb4lHMkptrCL7aXtc7",
  ghkcu50mg: "price_1ScaoTBb4lHMkptrCL7aXtc7",

  // Retatrutide
  "retatrutide-20mg": "price_1ScanwBb4lHMkptrMgFVPecU",
  "Retatrutide20mg-149": "price_1ScanwBb4lHMkptrMgFVPecU",
  retatrutide: "price_1ScanwBb4lHMkptrMgFVPecU",

  // Tirzepatide
  "tirzepatide-10mg": "price_1ScanFBb4lHMkptrVBOBoRdc",
  "Trizeputide-ruo10mg-95": "price_1ScanFBb4lHMkptrVBOBoRdc",
  trizeputide: "price_1ScanFBb4lHMkptrVBOBoRdc",
};

// ----- Product prices in cents (for subtotal & shipping) -----
const PRODUCT_PRICES = {
  "semax-10mg": 8000,
  "semaglutide-10mg": 12900,
  "cjc-1295-dac-10mg": 13900,
  "cjc-1295-no-dac-5mg": 7500,
  "sermorelin-5mg": 7900,
  "melanotan-ii-10mg": 7500,
  "bpc-157-5mg": 7900,
  "bpc-157": 7900,
  "ghk-cu-50mg": 6000,
  "ghkcu50mg": 6000,
  "retatrutide-20mg": 14900,
  retatrutide: 14900,
  "tirzepatide-10mg": 9500,
  trizeputide: 9500,
};

// ----- Health check -----
app.get("/", (req, res) => {
  res.send("Stripe backend is up");
});

// ----- Create Checkout Session -----
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error("❌ STRIPE_SECRET_KEY missing, cannot create 
session");
      return res.status(500).json({ error: "Stripe not configured" });
    }

    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    console.log("Incoming body:", JSON.stringify(req.body));

    if (rawItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const line_items = [];
    let subtotalCents = 0;

    // build product line items + subtotal
    for (let idx = 0; idx < rawItems.length; idx++) {
      const it = rawItems[idx];

      const qSrc =
        it.quantity !== undefined
          ? it.quantity
          : it.qty !== undefined
          ? it.qty
          : 1;
      const quantity = Number(qSrc) > 0 ? Number(qSrc) : 1;

      let priceId = it.price || it.priceId;
      const id = it.id;

      if (!priceId && id && PRICE_MAP[id]) {
        priceId = PRICE_MAP[id];
      }

      if (!priceId) {
        console.error("❌ Invalid cart item at index", idx, "item:", it);
        return res.status(400).json({
          error: "Invalid cart item",
          message: `Item at index ${idx} is missing a Stripe price 
mapping`,
          item: it,
        });
      }

      // accumulate subtotal from PRODUCT_PRICES
      const unitCents = PRODUCT_PRICES[id] || 0;
      subtotalCents += unitCents * quantity;

      line_items.push({ price: priceId, quantity });
    }

    // compute shipping from subtotal
    // rule: $6.95 if subtotal < $99, else free
    let shippingCents = 0;
    if (subtotalCents > 0 && subtotalCents < 9900) {
      shippingCents = 695; // $6.95 in cents
    }

    console.log(
      "Subtotal cents:",
      subtotalCents,
      "Shipping cents:",
      shippingCents
    );

    // add shipping line item if needed
    if (shippingCents > 0) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Shipping",
          },
          unit_amount: shippingCents,
        },
        quantity: 1,
      });
    }

    console.log("final line_items:", JSON.stringify(line_items));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: 
`${FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/cart?canceled=1`,
      automatic_tax: { enabled: false },
    });

    console.log("✅ Created Stripe session", session.id);

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ checkout error:", err);
    return res.status(500).json({
      error: "Server error",
      message: err && err.message ? err.message : "Unknown error",
    });
  }
});

// ----- Start server (Render uses PORT env) -----
const PORT = Number(process.env.PORT || 4242);
app.listen(PORT, () => {
  console.log("Stripe backend listening on port " + PORT);
});

module.exports = app;

