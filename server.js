"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

const allowedOrigins = [
  "https://arcticlabsupply.com",
  "https://www.arcticlabsupply.com",
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.ORIGIN,
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS_BLOCKED"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-token"],
}));

app.use(express.json({ limit: "1mb" }));
app.options("*", cors());

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

const SUPABASE_URL = String(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function requireAdmin(req) {
  const token = String(req.headers["x-admin-token"] || "");
  const expected = String(process.env.ADMIN_TOKEN || "");
  return token && expected && token === expected;
}

app.post("/orders/create", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const { items, totals, coupon, timestamp, orderId, shippingAddress } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "ITEMS_REQUIRED" });
  if (!totals || typeof totals !== "object") return res.status(400).json({ error: "TOTALS_REQUIRED" });

  const payload = {
    items,
    totals,
    coupon: coupon || null,
    client_timestamp: timestamp ? new Date(timestamp).toISOString() : null,
    order_id: orderId || null,
    shipping_address: shippingAddress || null,
    status: "new",
  };

  const cols = ["id","created_at","order_id","payment_status","paid_at","shipping_status","shipped_at"].join(", ");

  const { data, error } = await supabase.from("orders").insert([payload]).select(cols).single();
  if (error) return res.status(500).json({ error: "DB_INSERT_FAILED", details: error.message });

  res.json({ ok: true, order: data });
});

app.get("/admin/orders", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });
  if (!requireAdmin(req)) return res.status(401).json({ error: "UNAUTHORIZED" });

  const cols = ["id","created_at","items","totals","coupon","client_timestamp","status","order_id","shipping_address","payment_status","paid_at","square_transaction_id","shipping_status","shipped_at"].join(", ");

  const { data, error } = await supabase.from("orders").select(cols).order("created_at",{ascending:false}).limit(200);
  if (error) return res.status(500).json({ error: "DB_READ_FAILED", details: error.message });

  res.json({ orders: data });
});

app.post("/admin/orders/:id/ship", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });
  if (!requireAdmin(req)) return res.status(401).json({ error: "UNAUTHORIZED" });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_ID" });

  const shipped = !!req.body?.shipped;

  const { data, error } = await supabase
    .from("orders")
    .update({ shipping_status: shipped ? "shipped" : "not_shipped", shipped_at: shipped ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id, shipping_status, shipped_at")
    .single();

  if (error) return res.status(500).json({ error: "UPDATE_FAILED", details: error.message });
  res.json({ ok: true, order: data });
});

const SQUARE_ACCESS_TOKEN = String(process.env.SQUARE_ACCESS_TOKEN || "");
const SQUARE_LOCATION_ID = String(process.env.SQUARE_LOCATION_ID || "");
const SQUARE_ENV = String(process.env.SQUARE_ENV || "sandbox").toLowerCase();

const SQUARE_HOST = SQUARE_ENV === "production"
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

function looksLikePlaceholder(v) {
  return !v || v.includes("<");
}

async function squareRequest(path, method, body) {
  const r = await fetch(`${SQUARE_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2025-01-15",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

app.post("/square/create-checkout", async (req, res) => {
  if (looksLikePlaceholder(SQUARE_ACCESS_TOKEN) || looksLikePlaceholder(SQUARE_LOCATION_ID)) {
    return res.status(500).json({ error: "SQUARE_NOT_CONFIGURED" });
  }

  const { total, currency = "USD", returnUrl, cancelUrl, orderId } = req.body || {};
  const amount = Number(total);
  if (!amount || amount <= 0) return res.status(400).json({ error: "INVALID_TOTAL" });

  const payload = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: SQUARE_LOCATION_ID,
      ...(orderId ? { reference_id: String(orderId) } : {}),
      line_items: [{ name: "Order", quantity: "1", base_price_money: { amount: Math.round(amount * 100), currency } }],
    },
    checkout_options: { redirect_url: returnUrl, cancel_url: cancelUrl },
  };

  const r = await squareRequest("/v2/online-checkout/payment-links","POST",payload);
  if (!r.ok) return res.status(500).json({ error: "SQUARE_FAILED", details: r.json });

  res.json({ checkoutUrl: r.json?.payment_link?.url });
});

const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
