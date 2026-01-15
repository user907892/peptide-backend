"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { SquareClient, SquareEnvironment } = require("square");

dotenv.config();

const app = express();

/* CORS */
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
app.use(express.json());

/* Health */
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

/* Supabase */
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* Orders: create */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const body = req.body || {};
    const items = body.items;
    const totals = body.totals;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items required" });
    }
    if (!totals || typeof totals !== "object") {
      return res.status(400).json({ error: "totals required" });
    }

    const payload = {
      order_id: body.orderId || null,
      items,
      totals,
      coupon: body.coupon || null,
      shipping_address: body.shippingAddress || body.shipping || null,
      client_timestamp: body.timestamp ? new Date(body.timestamp).toISOString() : null,
      status: "new",
      payment_status: "pending",
    };

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select("id, created_at, order_id")
      .single();

    if (error) {
      return res.status(500).json({ error: "db insert failed", details: error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    return res.status(500).json({ error: "server error", details: String(err?.message || err) });
  }
});

/* Orders: confirm */
app.post("/orders/confirm", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, message: "Supabase not configured" });
    }

    const { orderId, transactionId, pendingOrder } = req.body || {};

    if (!pendingOrder) {
      return res.status(400).json({ ok: false, message: "Missing pendingOrder payload" });
    }

    const resolvedOrderId = orderId || pendingOrder.orderId || `ORD-${Date.now()}`;

    const totals = {
      sub: pendingOrder.subtotal ?? pendingOrder.sub ?? 0,
      discount: pendingOrder.discount ?? 0,
      shippingCost: pendingOrder.shippingCost ?? pendingOrder.shipping ?? 0,
      total: pendingOrder.total ?? 0,
    };

    const payload = {
      order_id: resolvedOrderId,
      items: pendingOrder.items || [],
      totals,
      coupon: pendingOrder.coupon || null,
      shipping_address: pendingOrder.shippingAddress || pendingOrder.shipping || null,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      square_transaction_id: transactionId || null,
      status: "paid",
    };

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select("id, created_at, order_id")
      .single();

    if (error) {
      return res.status(500).json({ ok: false, message: "Supabase insert failed", error: error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Server error", details: String(err?.message || err) });
  }
});

/* Admin */
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

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return res.status(500).json({ error: "db read failed", details: error.message });
    }

    return res.json({ orders: data });
  } catch (err) {
    return res.status(500).json({ error: "server error", details: String(err?.message || err) });
  }
});

/* Square checkout */
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = String(process.env.SQUARE_ENV || "sandbox").toLowerCase();

function getSquareEnvironment() {
  return SQUARE_ENV === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
}

const squareClient = SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      environment: getSquareEnvironment(),
      bearerAuthCredentials: { accessToken: SQUARE_ACCESS_TOKEN },
    })
  : null;

app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!squareClient || !SQUARE_LOCATION_ID) {
      return res.status(500).json({ error: "Square not configured" });
    }

    const amount = Number(req.body?.total);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }

    const cents = BigInt(Math.round(amount * 100));

    const resp = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Order Total",
            quantity: "1",
            basePriceMoney: { amount: cents, currency: "USD" },
          },
        ],
      },
      checkoutOptions: { redirectUrl: req.body.returnUrl },
    });

    const checkoutUrl = resp?.result?.paymentLink?.url;

    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkout URL returned" });
    }

    return res.json({ checkoutUrl });
  } catch (err) {
    return res.status(500).json({ error: "Square checkout failed", details: String(err?.message || err) });
  }
});

/* Start */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});
