"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

// ---------------- CORS ----------------
const allowedOrigins = [
  "https://arcticlabsupply.com",
  "https://www.arcticlabsupply.com",
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.ORIGIN,
].filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS_BLOCKED"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-token", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

// ---------------- Health ----------------
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

// ---------------- Supabase ----------------
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = 
String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function requireAdmin(req) {
  const token = String(req.headers["x-admin-token"] || "").trim();
  const expected = String(process.env.ADMIN_TOKEN || "").trim();
  return Boolean(expected) && token === expected;
}

// ---------------- Square (Payment Links) ----------------
const SQUARE_ACCESS_TOKEN = String(process.env.SQUARE_ACCESS_TOKEN || 
"").trim();
const SQUARE_LOCATION_ID = String(process.env.SQUARE_LOCATION_ID || 
"").trim();
const SQUARE_ENV = String(process.env.SQUARE_ENV || 
"sandbox").trim().toLowerCase();

const SQUARE_HOST =
  SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

function looksLikePlaceholder(v) {
  return !v || v.includes("<") || v.includes(">") || v.length < 10;
}

async function squareRequest(path, method, body) {
  const resp = await fetch(`${SQUARE_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2025-01-15",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}

app.get("/square/debug/locations", async (_req, res) => {
  const r = await squareRequest("/v2/locations", "GET");
  return res.status(r.status).json(r.json);
});

// ---------------- Orders: create ----------------
// Body: { items, totals, coupon, timestamp, orderId, shippingAddress }
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 
"SUPABASE_NOT_CONFIGURED" });

    const { items, totals, coupon, timestamp, orderId, shippingAddress } = 
req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "ITEMS_REQUIRED" });
    }
    if (!totals || typeof totals !== "object") {
      return res.status(400).json({ error: "TOTALS_REQUIRED" });
    }

    const payload = {
      order_id: orderId || null,
      shipping_address: shippingAddress || null,
      items,
      totals,
      coupon: coupon || null,
      client_timestamp: timestamp ? new Date(timestamp).toISOString() : 
null,
      status: "new",
    };

    const selectCols = [
      "id",
      "created_at",
      "order_id",
      "status",
      "payment_status",
      "paid_at",
      "shipping_status",
      "shipped_at",
    ].join(", ");

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select(selectCols)
      .single();

    if (error) {
      return res.status(500).json({ error: "DB_INSERT_FAILED", details: 
error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (e) {
    console.error("orders/create", e);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ---------------- Orders: confirm (SuccessPage calls this) 
----------------
// Body: { orderId, transactionId }
app.post("/orders/confirm", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 
"SUPABASE_NOT_CONFIGURED" });
    if (looksLikePlaceholder(SQUARE_ACCESS_TOKEN)) {
      return res.status(500).json({ error: "SQUARE_NOT_CONFIGURED" });
    }

    const { orderId, transactionId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "ORDER_ID_REQUIRED" 
});
    if (!transactionId) return res.status(400).json({ error: 
"TRANSACTION_ID_REQUIRED" });

    // Verify payment with Square
    const payResp = await squareRequest(
      `/v2/payments/${encodeURIComponent(String(transactionId))}`,
      "GET"
    );

    if (!payResp.ok) {
      return res.status(400).json({ error: "SQUARE_GET_PAYMENT_FAILED", 
details: payResp.json });
    }

    const payment = payResp.json?.payment;
    const squareStatus = payment?.status;

    if (squareStatus !== "COMPLETED") {
      return res.json({ ok: true, status: "not_paid", square_status: 
squareStatus || "UNKNOWN" });
    }

    const selectCols = [
      "id",
      "order_id",
      "payment_status",
      "paid_at",
      "square_transaction_id",
      "status",
    ].join(", ");

    const { data, error } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        status: "paid",
        paid_at: new Date().toISOString(),
        square_transaction_id: String(transactionId),
      })
      .eq("order_id", String(orderId))
      .select(selectCols)
      .single();

    if (error) {
      return res.status(500).json({ error: "DB_UPDATE_FAILED", details: 
error.message });
    }

    const amountCents = payment?.amount_money?.amount ?? null;
    const currency = payment?.amount_money?.currency ?? "USD";

    return res.json({
      ok: true,
      status: "paid",
      order: data,
      square: { amount: amountCents != null ? amountCents / 100 : null, 
currency },
    });
  } catch (e) {
    console.error("orders/confirm", e);
    if (res.headersSent) return;
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ---------------- Admin: list orders ----------------
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 
"SUPABASE_NOT_CONFIGURED" });
    if (!requireAdmin(req)) return res.status(401).json({ error: 
"UNAUTHORIZED" });

    const selectCols = [
      "id",
      "created_at",
      "order_id",
      "items",
      "totals",
      "coupon",
      "client_timestamp",
      "status",
      "payment_status",
      "paid_at",
      "square_transaction_id",
      "shipping_address",
      "shipping_status",
      "shipped_at",
    ].join(", ");

    const { data, error } = await supabase
      .from("orders")
      .select(selectCols)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: "DB_READ_FAILED", 
details: error.message });

    return res.json({ orders: data || [] });
  } catch (e) {
    console.error("admin/orders", e);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ---------------- Admin: mark shipped/unshipped ----------------
app.post("/admin/orders/:id/ship", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 
"SUPABASE_NOT_CONFIGURED" });
    if (!requireAdmin(req)) return res.status(401).json({ error: 
"UNAUTHORIZED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ 
error: "INVALID_ID" });

    const shipped = Boolean(req.body && req.body.shipped);

    const { data, error } = await supabase
      .from("orders")
      .update({
        shipping_status: shipped ? "shipped" : "not_shipped",
        shipped_at: shipped ? new Date().toISOString() : null,
      })
      .eq("id", id)
      .select(["id", "shipping_status", "shipped_at"].join(", "))
      .single();

    if (error) return res.status(500).json({ error: "UPDATE_FAILED", 
details: error.message });

    return res.json({ ok: true, order: data });
  } catch (e) {
    console.error("admin/orders/:id/ship", e);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ---------------- Square: create checkout ----------------
// Body: { total, currency, returnUrl, cancelUrl, orderId }
app.post("/square/create-checkout", async (req, res) => {
  try {
    if (looksLikePlaceholder(SQUARE_ACCESS_TOKEN) || 
looksLikePlaceholder(SQUARE_LOCATION_ID)) {
      return res.status(500).json({ error: "SQUARE_NOT_CONFIGURED" });
    }

    const { total, currency = "USD", returnUrl, cancelUrl, orderId } = 
req.body || {};
    const amount = Number(total);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "INVALID_TOTAL", got: total });
    }
    if (!returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "MISSING_REDIRECT_URLS" });
    }

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: SQUARE_LOCATION_ID,
        ...(orderId ? { reference_id: String(orderId) } : {}),
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

    const r = await squareRequest("/v2/online-checkout/payment-links", 
"POST", payload);

    if (!r.ok) {
      return res.status(500).json({ error: "SQUARE_FAILED", details: 
r.json });
    }

    const checkoutUrl = r.json?.payment_link?.url || null;
    if (!checkoutUrl) {
      return res.status(500).json({ error: "SQUARE_NO_CHECKOUT_URL", 
details: r.json });
    }

    return res.json({ checkoutUrl });
  } catch (e) {
    console.error("square/create-checkout", e);
    if (res.headersSent) return;
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ---------------- Start ----------------
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});

