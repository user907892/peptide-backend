"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

/* -----------------------
   CORS
------------------------ */
const allowedOrigins = [
  "https://arcticlabsupply.com",
  "https://www.arcticlabsupply.com",
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-token"],
  })
);

app.options("*", cors());
app.use(express.json({ limit: "1mb" }));

/* -----------------------
   Health
------------------------ */
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

/* -----------------------
   Supabase
------------------------ */
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = 
String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

console.log("Supabase URL present:", !!SUPABASE_URL);
console.log("Supabase service key present:", !!SUPABASE_SERVICE_ROLE_KEY);

/* -----------------------
   Orders: create
   POST /orders/create
------------------------ */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
const { items, totals, coupon, timestamp } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items required" });
    }
    if (!totals || typeof totals !== "object") {
      return res.status(400).json({ error: "totals required" });
    }

    const payload = {
      items,
      totals,
      coupon: coupon || null,
      client_timestamp: timestamp ? new Date(timestamp).toISOString() : 
null,
      status: "new",
    };

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select("id, created_at")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "db insert failed", details: 
error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create error:", err);
    return res.status(500).json({ error: "server error", details: 
String(err?.message || err) });
  }
});

/* -----------------------
   Orders: admin list
   GET /admin/orders
------------------------ */
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not 
configured" });

    const token = String(req.headers["x-admin-token"] || "").trim();
    const expected = String(process.env.ADMIN_TOKEN || "").trim();

    if (!expected || token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // Keep the select string on ONE LINE
    const selectCols = "id, created_at, items, totals, coupon, 
client_timestamp, status";

    const { data, error } = await supabase
      .from("orders")
      .select(selectCols)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("Supabase list error:", error);
      return res.status(500).json({ error: "db read failed", details: 
error.message });
    }

    return res.json({ orders: data });
  } catch (err) {
    console.error("admin/orders error:", err);
    return res.status(500).json({ error: "server error", details: 
String(err?.message || err) });
  }
});

/* -----------------------
   Square (FIXED)
   We use raw REST calls so SQUARE_HOST actually matters
------------------------ */
const SQUARE_ACCESS_TOKEN = String(process.env.SQUARE_ACCESS_TOKEN || 
"").trim();
const SQUARE_LOCATION_ID = String(process.env.SQUARE_LOCATION_ID || 
"").trim();
const SQUARE_ENV_RAW = String(process.env.SQUARE_ENV || 
"sandbox").trim().toLowerCase();

const DEFAULT_SQUARE_HOST =
  SQUARE_ENV_RAW === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const SQUARE_HOST = String(process.env.SQUARE_HOST || 
DEFAULT_SQUARE_HOST).trim();

// Helpful startup diagnostics (safe: no secrets)
console.log("Square env:", SQUARE_ENV_RAW);
console.log("Square host:", SQUARE_HOST);
console.log("Square token present:", SQUARE_ACCESS_TOKEN.length > 0);
console.log("Square token prefix/len:", SQUARE_ACCESS_TOKEN.slice(0, 6), 
SQUARE_ACCESS_TOKEN.length);
console.log("Square location prefix/len:", SQUARE_LOCATION_ID.slice(0, 6), 
SQUARE_LOCATION_ID.length);

// Guard against accidentally pasting placeholders like "<Production 
Access Token>"
function looksLikePlaceholder(s) {
  return !s || s.includes("<") || s.includes(">") || 
s.toLowerCase().includes("production access token");
}

async function squareRequest(path, { method = "GET", body } = {}) {
  if (!SQUARE_ACCESS_TOKEN || looksLikePlaceholder(SQUARE_ACCESS_TOKEN)) {
    return {
      ok: false,
      status: 500,
      json: {
        error: "Square not configured",
        message:
          "SQUARE_ACCESS_TOKEN is missing or looks like a placeholder. Set 
the real Production Access Token in Render.",
      },
    };
  }

  const url = `${SQUARE_HOST}${path}`;
  const headers = {
    Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": String(process.env.SQUARE_VERSION || "2025-01-15"),
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = { error: "Non-JSON response from Square" };
  }

  return { ok: resp.ok, status: resp.status, json: data };
}

/**
 * Debug endpoint: proves token+host are valid.
 * Hit this in browser:
 *   https://<your-backend>/square/debug/locations
 */
app.get("/square/debug/locations", async (_req, res) => {
  try {
    const r = await squareRequest("/v2/locations");
    return res.status(r.status).json(r.json);
  } catch (err) {
    console.error("square/debug/locations error:", err);
    return res.status(500).json({ error: "server error", details: 
String(err?.message || err) });
  }
});

/**
 * Create checkout (Payment Link)
 * POST /square/create-checkout
 * body: { total, currency, returnUrl, cancelUrl }
 */
app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!SQUARE_LOCATION_ID || looksLikePlaceholder(SQUARE_LOCATION_ID)) {
      return res.status(500).json({
        error: "Square not configured",
        message:
          "Missing SQUARE_LOCATION_ID (or it looks like a placeholder). 
Set the real Production Location ID in Render.",
      });
    }

    const { total, currency = "USD", returnUrl, cancelUrl } = req.body || 
{};

    const amount = Number(total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }
    if (!returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing returnUrl/cancelUrl" 
});
    }

    const cents = Math.round(amount * 100); // Square expects integer 
cents
    const idempotencyKey = crypto.randomUUID();

    // Square endpoint: CreatePaymentLink
    const payload = {
      idempotency_key: idempotencyKey,
      order: {
        location_id: SQUARE_LOCATION_ID,
        line_items: [
          {
            name: "Order Total",
            quantity: "1",
            base_price_money: { amount: cents, currency },
          },
        ],
      },
      checkout_options: {
        redirect_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const r = await squareRequest("/v2/online-checkout/payment-links", {
      method: "POST",
      body: payload,
    });

    if (!r.ok) {
      // Bubble up Square’s real error instead of hiding it
      console.error("Square create-checkout failed:", r.status, r.json);
      return res.status(500).json({
        error: "Square create-checkout failed",
        details: r.json?.errors || r.json || null,
        squareStatus: r.status,
        squareHost: SQUARE_HOST,
        squareEnv: SQUARE_ENV_RAW,
      });
    }

    const url =
      r.json?.payment_link?.url ||
      r.json?.paymentLink?.url ||
      r.json?.payment_link_url ||
      r.json?.url;

    if (!url) {
      return res.status(500).json({ error: "No checkout URL returned", 
details: r.json || null });
    }

    return res.json({ checkoutUrl: url });
  } catch (err) {
    console.error("Square create-checkout error:", err);
    return res.status(500).json({
      error: "Square create-checkout failed",
      details: String(err?.message || err),
    });
  }
});

/* -----------------------
   Start server
------------------------ */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});

