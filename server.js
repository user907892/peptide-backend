"use strict";

/*
server.js
ArcticLabSupply backend (Render)
Stripe Checkout + PayPal Orders API + Square Hosted Checkout
Node 18+ includes global fetch. Render Node 22 is fine.
*/

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const crypto = require("crypto");

// ✅ IMPORTANT: load Square in a way that works across SDK versions
const Square = require("square");
const SquareClient = Square.Client || Square?.default?.Client;
const SquareEnvironment = Square.Environment || 
Square?.default?.Environment;

const app = express();

/* =======================
   CORS
======================= */
app.use(
  cors({
    origin: [
      "https://arcticlabsupply.com",
      "https://www.arcticlabsupply.com",
      "http://localhost:5173",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());
app.use(express.json());

/* =======================
   Stripe
======================= */
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn("⚠️ STRIPE_SECRET_KEY not set");
}

function normalizeCoupon(code) {
  return String(code || "").trim().toUpperCase();
}

/* =======================
   PayPal
======================= */
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();

const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal env vars missing");
  }

  const auth = 
Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error("PayPal auth failed");
  return data.access_token;
}

/* =======================
   Square
======================= */
let square = null;

if (process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID) {
  if (!SquareClient || !SquareEnvironment) {
    // If the SDK export shape changed, fail gracefully (don’t crash 
deploy)
    console.warn("⚠️ Square SDK loaded but missing Client/Environment 
exports. Check square package version.");
  } else {
    const isSandbox = (process.env.SQUARE_ENV || 
"production").toLowerCase() === "sandbox";

    square = new SquareClient({
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
      environment: isSandbox ? SquareEnvironment.Sandbox : 
SquareEnvironment.Production,
    });
  }
} else {
  console.warn("⚠️ Square env vars not set");
}

/* =======================
   Health
======================= */
app.get("/", (_, res) => {
  res.json({ status: "ok", service: "arcticlabsupply-backend" });
});

/* =======================
   Square: Create Checkout
======================= */
app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!square) {
      return res.status(500).json({ error: "Square not configured" });
    }

    const total = Number(req.body.total);
    const successUrl = req.body.successUrl;

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }
    if (!successUrl) {
      return res.status(400).json({ error: "Missing successUrl" });
    }

    const idempotencyKey = crypto.randomUUID();

    const { result } = await square.checkoutApi.createPaymentLink({
      idempotencyKey,
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Arctic Labs Order",
            quantity: "1",
            basePriceMoney: { amount: Math.round(total * 100), currency: 
"USD" },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: successUrl,
        askForShippingAddress: true,
      },
    });

    const url = result?.paymentLink?.url;
    if (!url) {
      return res.status(500).json({ error: "Square did not return checkout 
URL" });
    }

    return res.json({ url });
  } catch (err) {
    console.error("Square error:", err);
    return res.status(500).json({ error: "Square checkout failed" });
  }
});

/* =======================
   PayPal: Create Order
======================= */
app.post("/paypal/create-order", async (req, res) => {
  try {
    const total = Number(req.body.total);
    const returnUrl = req.body.returnUrl;
    const cancelUrl = req.body.cancelUrl;

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }
    if (!returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing URLs" });
    }

    const token = await getPayPalAccessToken();

    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": 
"application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: 
total.toFixed(2) } }],
        application_context: {
          brand_name: "Arctic Labs Supply",
          user_action: "PAY_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error("PayPal create failed");

    const approve = data.links?.find((l) => l.rel === "approve")?.href;
    return res.json({ orderID: data.id, approveUrl: approve });
  } catch (err) {
    console.error("PayPal error:", err);
    return res.status(500).json({ error: "PayPal checkout failed" });
  }
});

/* =======================
   Stripe: Create Session
======================= */
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured" });
    }

    const items = req.body.items || [];
    if (!items.length) {
      return res.status(400).json({ error: "No items" });
    }

    const line_items = items.map((i) => ({
      price: i.id,
      quantity: i.quantity || 1,
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: 
"https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://arcticlabsupply.com/cart",
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    return res.status(500).json({ error: "Stripe checkout failed" });
  }
});

/* =======================
   Start Server
======================= */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});

