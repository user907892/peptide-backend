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
const SUPABASE_SERVICE_ROLE_KEY = 
String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* Orders: create (pre-checkout record) */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const body = req.body || {};
    const items = body.items;
    const totals = body.totals;
    const coupon = body.coupon;
    const timestamp = body.timestamp;

    // NEW (optional): shippingAddress + orderId
    const orderId = body.orderId || null;
    const shippingAddress = body.shippingAddress || body.shipping || null;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items required" });
    }
    if (!totals || typeof totals !== "object") {
      return res.status(400).json({ error: "totals required" });
    }

    const payload = {
      order_id: orderId || null,
      items,
      totals,
      coupon: coupon || null,
      shipping_address: shippingAddress,
      client_timestamp: timestamp ? new Date(timestamp).toISOString() : 
null,
      status: "new",
      payment_status: "pending",
    };

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select("id, created_at, order_id")
      .single();

    if (error) {
      return res.status(500).json({ error: "db insert failed", details: 
error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    return res.status(500).json({ error: "server error", details: 
String(err?.message || err) });
  }
});

/* Orders: confirm (called from /success after Square redirect) */
app.post("/orders/confirm", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, message: "Supabase not 
configured" });
    }

    const { orderId, transactionId, pendingOrder } = req.body || {};

    if (!pendingOrder) {
      return res.status(400).json({ ok: false, message: "Missing 
pendingOrder payload" });
    }

    const resolvedOrderId = orderId || pendingOrder.orderId || ("ORD-" + 
Date.now());

    // Normalize shipping naming (supports either shippingAddress or 
shipping)
    const shippingAddress = pendingOrder.shippingAddress || 
pendingOrder.shipping || null;

    const totals = {
      sub: pendingOrder.subtotal ?? pendingOrder.sub ?? 0,
      discount: pendingOrder.discount ?? 0,
      shippingCost: pendingOrder.shippingCost ?? pendingOrder.shippingCost 
?? pendingOrder.shipping ?? 0,
      total: pendingOrder.total ?? 0,
    };

    // ✅ Try to update an existing row created earlier (if you created 
one before redirect)
    // If no row exists, we insert a new one.
    const updatePayload = {
      order_id: resolvedOrderId,
      items: pendingOrder.items || [],
      totals,
      coupon: pendingOrder.coupon || null,
      shipping_address: shippingAddress,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      square_transaction_id: transactionId || null,
      status: "paid",
    };

    // Attempt update by order_id first
    const { data: updated, error: updateErr } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("order_id", resolvedOrderId)
      .select("id, created_at, order_id, payment_status, paid_at")
      .maybeSingle();

    if (updateErr) {
      console.error("Supabase update error:", updateErr);
      return res.status(500).json({ ok: false, message: "Supabase update 
failed", error: updateErr.message });
    }

    if (updated) {
      return res.json({ ok: true, mode: "updated", order: updated });
    }

    // If update didn't find a row, insert new
    const insertPayload = {
      order_id: resolvedOrderId,
      items: pendingOrder.items || [],
      totals,
      coupon: pendingOrder.coupon || null,
      shipping_address: shippingAddress,
      client_timestamp: pendingOrder.createdAt ? new 
Date(pendingOrder.createdAt).toISOString() : null,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      square_transaction_id: transactionId || null,
      status: "paid",
    };

    const { data: inserted, error: insertErr } = await supabase
      .from("orders")
      .insert([insertPayload])
      .select("id, created_at, order_id, payment_status, paid_at")
      .single();

    if (insertErr) {
      console.error("Supabase insert error:", insertErr);
      return res.status(500).json({ ok: false, message: "Supabase insert 
failed", error: insertErr.message });
    }

    return res.json({ ok: true, mode: "inserted", order: inserted });
  } catch (e) {
    console.error("orders/confirm crash:", e);
    return res.status(500).json({ ok: false, message: "Server error", 
details: String(e?.message || e) });
  }
});

/* Admin: list orders (UPDATED to include shipping + payment) */
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

    const selectCols = [
      "id",
      "created_at",
      "order_id",
      "items",
      "totals",
      "coupon",
      "client_timestamp",
      "status",
      "shipping_address",
      "payment_status",
      "paid_at",
      "square_transaction_id",
    ].join(",");

    const { data, error } = await supabase
      .from("orders")
      .select(selectCols)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return res.status(500).json({ error: "db read failed", details: 
error.message });
    }

    return res.json({ orders: data });
  } catch (err) {
    return res.status(500).json({ error: "server error", details: 
String(err?.message || err) });
  }
});

/* Square client + route */
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = String(process.env.SQUARE_ENV || 
"sandbox").toLowerCase();

function getSquareEnvironment() {
  return SQUARE_ENV === "production" ? SquareEnvironment.Production : 
SquareEnvironment.Sandbox;
}

const squareClient = SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      environment: getSquareEnvironment(),
      token: SQUARE_ACCESS_TOKEN,
      accessToken: SQUARE_ACCESS_TOKEN,
      bearerAuthCredentials: { accessToken: SQUARE_ACCESS_TOKEN },
    })
  : null;

app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!squareClient || !SQUARE_LOCATION_ID) {
      return res.status(500).json({
        error: "Square not configured",
        message: "Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID",
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

    const centsNumber = Math.round(amount * 100);
    const cents = BigInt(centsNumber);
    const idempotencyKey = crypto.randomUUID();

    const resp = await squareClient.checkout.paymentLinks.create({
      idempotencyKey,
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Order Total",
            quantity: "1",
            basePriceMoney: { amount: cents, currency },
          },
        ],
      },
      checkoutOptions: { redirectUrl: returnUrl },
    });

    const body = resp?.result ?? resp;
    const checkoutUrl =
      body?.paymentLink?.url ||
      body?.payment_link?.url ||
      body?.paymentLinkUrl ||
      body?.url;

    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkout URL returned" });
    }

    return res.json({ checkoutUrl });
  } catch (err) {
    return res.status(500).json({ error: "Square create-checkout failed", 
details: String(err?.message || err) });
  }
});

/* Start */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});

