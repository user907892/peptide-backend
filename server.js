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

app.use(express.json({ limit: "1mb" }));
app.options("*", cors());

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
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

console.log("Supabase URL present:", !!SUPABASE_URL);
console.log("Supabase service key present:", !!SUPABASE_SERVICE_ROLE_KEY);

/* -----------------------
   Orders: create
------------------------ */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

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
      client_timestamp: timestamp
        ? new Date(timestamp).toISOString()
        : null,
      status: "new",
    };

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select("id, created_at")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res
        .status(500)
        .json({ error: "db insert failed", details: error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create error:", err);
    return res
      .status(500)
      .json({ error: "server error", details: String(err) });
  }
});

/* -----------------------
   Orders: admin list
------------------------ */
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const token = String(req.headers["x-admin-token"] || "").trim();
    const expected = String(process.env.ADMIN_TOKEN || "").trim();

    if (!expected || token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const selectCols =
      "id, created_at, items, totals, coupon, client_timestamp, status";

    const { data, error } = await supabase
      .from("orders")
      .select(selectCols)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("Supabase list error:", error);
      return res
        .status(500)
        .json({ error: "db read failed", details: error.message });
    }

    return res.json({ orders: data });
  } catch (err) {
    console.error("admin/orders error:", err);
    return res
      .status(500)
      .json({ error: "server error", details: String(err) });
  }
});

/* -----------------------
   Square config
------------------------ */
const SQUARE_ACCESS_TOKEN = String(
  process.env.SQUARE_ACCESS_TOKEN || ""
).trim();
const SQUARE_LOCATION_ID = String(
  process.env.SQUARE_LOCATION_ID || ""
).trim();
const SQUARE_ENV = String(process.env.SQUARE_ENV || "sandbox")
  .trim()
  .toLowerCase();

const SQUARE_HOST =
  SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

console.log("Square env:", SQUARE_ENV);
console.log("Square host:", SQUARE_HOST);
console.log(
  "Square token prefix/len:",
  SQUARE_ACCESS_TOKEN.slice(0, 6),
  SQUARE_ACCESS_TOKEN.length
);

/* -----------------------
   Square helpers
------------------------ */
function looksLikePlaceholder(v) {
  return !v || v.includes("<") || v.includes(">");
}

async function squareRequest(path, method, body) {
  const res = await fetch(`${SQUARE_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2025-01-15",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/* -----------------------
   Square debug
------------------------ */
app.get("/square/debug/locations", async (_req, res) => {
  const r = await squareRequest("/v2/locations", "GET");
  res.status(r.status).json(r.json);
});

/* -----------------------
   Square checkout
------------------------ */
app.post("/square/create-checkout", async (req, res) => {
  try {
    if (
      looksLikePlaceholder(SQUARE_ACCESS_TOKEN) ||
      looksLikePlaceholder(SQUARE_LOCATION_ID)
    ) {
      return res
        .status(500)
        .json({ error: "Square not configured correctly" });
    }

    const { total, currency = "USD", returnUrl, cancelUrl } = req.body;

    const amount = Number(total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: SQUARE_LOCATION_ID,
        line_items: [
          {
            name: "Order",
            quantity: "1",
            base_price_money: {
              amount: Math.round(amount * 100),
              currency,
            },
          },
        ],
      },
      checkout_options: {
        redirect_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };

    const r = await squareRequest(
      "/v2/online-checkout/payment-links",
      "POST",
      payload
    );

    if (!r.ok) {
      console.error("Square error:", r.json);
      return res
        .status(500)
        .json({ error: "Square checkout failed", details: r.json });
    }

    return res.json({ checkoutUrl: r.json.payment_link.url });
  } catch (err) {
    console.error("checkout error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/* -----------------------
   Start server
------------------------ */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
