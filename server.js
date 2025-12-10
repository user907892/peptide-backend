// server.js
require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: "200kb" }));

// Trust proxy (Render sets X-Forwarded-* headers)
app.set("trust proxy", 1);

// Stripe init
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ STRIPE_SECRET_KEY is not set. Stripe calls will 
fail.");
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// Frontend URL (where Stripe sends users back)
const FRONTEND_URL = process.env.FRONTEND_URL || 
"https://arcticlabsupply.com";

// Build allowed origins list (comma-separated ORIGIN env supported)
const defaultOrigins = [
  "http://localhost:5173",
  "https://arcticlabsupply.com",
  "https://arcticlabsupply.netlify.app",
];

const allowedOrigins = (() => {
  if (process.env.ORIGIN) {
    return process.env.ORIGIN.split(",").map((s) => 
s.trim()).filter(Boolean);
  }
  return defaultOrigins;
})();

// Always include FRONTEND_URL in the allowed list (avoid accidental 
lockout)
if (FRONTEND_URL && !allowedOrigins.includes(FRONTEND_URL)) {
  allowedOrigins.push(FRONTEND_URL);
}

console.log("CORS allowed origins:", allowedOrigins);

// CORS middleware: allow non-browser clients (no origin), and only 
allowed origins otherwise.
// In non-production (NODE_ENV !== 'production') allow all origins to 
simplify local debugging.
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (curl, Stripe webhooks, 
server-to-server)
      if (!origin) return callback(null, true);

      // Allow if origin is in allowedOrigins
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // In development, be permissive (helpful when testing from varied 
origins)
      if (process.env.NODE_ENV !== "production") {
        console.warn("CORS: allowing dev origin:", origin);
        return callback(null, true);
      }

      console.warn("❌ CORS blocked for origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    optionsSuccessStatus: 200,
  })
);

// Pre-flight handler for all routes
app.options("*", cors());

// ----- Product -> Price ID map -----
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

// Health check
app.get("/", (req, res) => {
  res.send("Stripe backend is up");
});

// Create Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    console.log("Incoming body:", JSON.stringify(req.body));

    if (rawItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const line_items = rawItems.map((it, idx) => {
      const qSrc =
        it.quantity !== undefined ? it.quantity : it.qty !== undefined ? 
it.qty : 1;
      const quantity = Number(qSrc) > 0 ? Number(qSrc) : 1;

      let priceId = it.price || it.priceId;

      if (!priceId && it.id && PRICE_MAP[it.id]) {
        priceId = PRICE_MAP[it.id];
      }

      if (!priceId) {
        throw new Error("Bad item at index " + idx + " : " + 
JSON.stringify(it));
      }

      return { price: priceId, quantity };
    });

    console.log("line_items:", JSON.stringify(line_items));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: 
`${FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/cart?canceled=1`,
      automatic_tax: { enabled: false },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("checkout error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Start server
const PORT = Number(process.env.PORT || 4242);
app.listen(PORT, () => {
  console.log("Stripe backend listening on port " + PORT);
});

module.exports = app;
