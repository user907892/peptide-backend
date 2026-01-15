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
const { Client, Environment } = require("square");

const app = express();

// CORS
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

// =====================
// Stripe
// =====================
let stripe = null;
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("Missing STRIPE_SECRET_KEY.");
} else {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

function normalizeCoupon(code) {
  return String(code || "").trim().toUpperCase();
}

// =====================
// PayPal
// =====================
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();

const PAYPAL_BASE =
  PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : 
"https://api-m.sandbox.paypal.com";

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
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
  if (!resp.ok) {
    console.error("PayPal token error:", data);
    throw new Error(data?.error_description || "PayPal token error");
  }
  return data.access_token;
}

// =====================
// Square
// =====================
let square = null;
if (!process.env.SQUARE_ACCESS_TOKEN || !process.env.SQUARE_LOCATION_ID) {
  console.warn("Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID.");
} else {
  const env = (process.env.SQUARE_ENV || "production").toLowerCase();
  square = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: env === "sandbox" ? Environment.Sandbox : 
Environment.Production,
  });
}

// =====================
// Health
// =====================
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "ArcticLabSupply backend live" });
});

// =====================
// Square: create checkout url
// =====================
app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!square) {
      return res.status(500).json({ error: "Square not configured" });
    }

    const body = req.body || {};
    const totalNum = Number(body.total);
    const currency = body.currency || "USD";
    const successUrl = body.successUrl;

    if (!Number.isFinite(totalNum) || totalNum <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }
    if (!successUrl) {
      return res.status(400).json({ error: "Missing successUrl" });
    }

    const idempotencyKey =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const { result } = await square.checkoutApi.createPaymentLink({
      idempotencyKey,
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Arctic Labs Order",
            quantity: "1",
            basePriceMoney: { amount: Math.round(totalNum * 100), currency 
},
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: successUrl,
        askForShippingAddress: true,
        merchantSupportEmail: "support@arcticlabsupply.com",
      },
      description: "Arctic Labs Supply checkout",
    });

    const url = result && result.paymentLink && result.paymentLink.url;
    if (!url) {
      return res.status(500).json({ error: "Square did not return checkout 
URL" });
    }

    return res.json({ url });
  } catch (err) {
    console.error("Square create-checkout error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// =====================
// PayPal: Create Order
// =====================
app.post("/paypal/create-order", async (req, res) => {
  try {
    const { total, currency = "USD", returnUrl, cancelUrl } = req.body || 
{};

    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(500).json({ error: "PayPal not configured" });
    }

    const value = Number(total);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }
    if (!returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing returnUrl/cancelUrl" 
});
    }

    const accessToken = await getPayPalAccessToken();

    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        { amount: { currency_code: currency, value: value.toFixed(2) }, 
description: "Order" },
      ],
      application_context: {
        brand_name: "Arctic Labs Supply",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const ppResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": 
"application/json" },
      body: JSON.stringify(payload),
    });

    const data = await ppResp.json();
    if (!ppResp.ok) {
      console.error("PayPal create-order error:", data);
      return res.status(500).json({ error: "Create order failed", details: 
data });
    }

    const approveUrl = (data.links || []).find((l) => l.rel === 
"approve")?.href;
    return res.json({ orderID: data.id, approveUrl });
  } catch (err) {
    console.error("PayPal create-order server error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// =====================
// PayPal: Capture Order
// =====================
app.post("/paypal/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "Missing orderID" 
});

    const accessToken = await getPayPalAccessToken();

    const ppResp = await 
fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": 
"application/json" },
    });

    const data = await ppResp.json();
    if (!ppResp.ok) {
      console.error("PayPal capture error:", data);
      return res.status(500).json({ error: "Capture failed", details: data 
});
    }

    return res.json(data);
  } catch (err) {
    console.error("PayPal capture server error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// =====================
// Stripe: Create Checkout Session (kept)
// =====================
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured", 
message: "Missing STRIPE_SECRET_KEY" });
    }

    const { items, shipping, coupon } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const line_items = [];
    for (const item of items) {
      if (!item || !item.id) continue;
      line_items.push({ price: item.id, quantity: Number(item.quantity) > 
0 ? Number(item.quantity) : 1 });
    }

    if (typeof shipping === "number" && shipping > 0) {
      line_items.push({
        price_data: { currency: "usd", product_data: { name: "Shipping" }, 
unit_amount: Math.round(shipping * 100) },
        quantity: 1,
      });
    }

    if (line_items.length === 0) return res.status(400).json({ error: "No 
valid line items" });

    const normalizedCoupon = normalizeCoupon(coupon);
    let discounts;
    let appliedPromotionCodeId = null;

    if (normalizedCoupon) {
      const promos = await stripe.promotionCodes.list({ code: 
normalizedCoupon, active: true, limit: 1 });
      if (!promos.data.length) return res.status(400).json({ error: 
"Invalid coupon code" });
      appliedPromotionCodeId = promos.data[0].id;
      discounts = [{ promotion_code: appliedPromotionCodeId }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      discounts: discounts || undefined,
      success_url: 
"https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://arcticlabsupply.com/cart",
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      metadata: {
        source: "arcticlabsupply-cart",
        coupon_code: normalizedCoupon || "",
        promotion_code_id: appliedPromotionCodeId || "",
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe create-checkout-session error:", err);
    return res.status(500).json({ error: "Failed to create checkout 
session", message: err?.message || "unknown error" });
  }
});

// =====================
// Stripe session endpoint (kept)
// =====================
app.get("/stripe/session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured", 
message: "Missing STRIPE_SECRET_KEY" });
    }

    const { session_id } = req.query || {};
    if (!session_id) return res.status(400).json({ error: "Missing 
session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent", "line_items.data.price.product"],
    });

    const transaction_id =
      (typeof session.payment_intent === "string" ? session.payment_intent 
: session.payment_intent?.id) || session.id;

    const value = (session.amount_total || 0) / 100;
    const currency = (session.currency || "usd").toUpperCase();

    const items =
      session.line_items?.data?.map((li) => {
        const price = li.price;
        const product = price?.product;
        return {
          item_id: (typeof product === "object" && product?.id) || 
price?.id || "unknown",
          item_name: (typeof product === "object" && product?.name) || 
li.description || "Item",
          price: (price?.unit_amount || 0) / 100,
          quantity: li.quantity || 1,
        };
      }) || [];

    return res.json({
      session_id: session.id,
      transaction_id,
      value,
      currency,
      items,
      coupon_code: session.metadata?.coupon_code || "",
      promotion_code_id: session.metadata?.promotion_code_id || "",
    });
  } catch (err) {
    console.error("Stripe session error:", err);
    return res.status(500).json({ error: "Failed to retrieve session", 
message: err?.message || "unknown error" });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`ArcticLabSupply backend listening on port ${PORT}`);
});

