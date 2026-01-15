"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { SquareClient, SquareEnvironment } = require("square");

dotenv.config();

const app = express();

/* -----------------------
   CORS (supports comma-separated ORIGIN list)
------------------------ */
const originEnv = String(process.env.ORIGIN || "").trim();
const allowedOrigins = originEnv
  ? originEnv.split(",").map(s => s.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin(origin, cb) {
      // allow server-to-server and local tools
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, true);
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
   Helpers
------------------------ */
function mask(token) {
  const t = String(token || "");
  if (t.length <= 8) return "********";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}
function sha256(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

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
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* -----------------------
   Orders: create
   POST /orders/create
------------------------ */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { orderId, items, totals, coupon, timestamp, shippingAddress } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: "items required" });
    if (!totals || typeof totals !== "object") return res.status(400).json({ ok: false, error: "totals required" });

    const payload = {
      order_id: String(orderId),
      items,
      totals,
      coupon: coupon || null,
      shipping_address: shippingAddress || null,
      client_timestamp: timestamp ? new Date(timestamp).toISOString() : null,
      status: "new",
      payment_status: "pending",
    };

    const { data, error } = await supabase.from("orders").insert([payload]).select("*").single();
    if (error) throw error;

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create error:", err);
    return res.status(500).json({ ok: false, error: "Order create failed" });
  }
});

/* -----------------------
   Orders: confirm
   POST /orders/confirm
------------------------ */
app.post("/orders/confirm", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { orderId, transactionId, pendingOrder } = req.body || {};
    if (!pendingOrder) return res.status(400).json({ ok: false, error: "Missing pendingOrder" });

    const resolvedOrderId = orderId || pendingOrder.orderId;
    if (!resolvedOrderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const totals = {
      sub: pendingOrder.subtotal ?? pendingOrder.sub ?? 0,
      discount: pendingOrder.discount ?? 0,
      shippingCost: pendingOrder.shippingCost ?? pendingOrder.shipping ?? 0,
      total: pendingOrder.total ?? 0,
    };

    const shippingAddress = pendingOrder.shippingAddress || pendingOrder.shipping || null;

    const payload = {
      order_id: String(resolvedOrderId),
      items: pendingOrder.items || [],
      totals,
      coupon: pendingOrder.coupon || null,
      shipping_address: shippingAddress,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      square_transaction_id: transactionId || null,
      status: "paid",
    };

    const { data: updated, error: updateErr } = await supabase
      .from("orders")
      .update(payload)
      .eq("order_id", String(resolvedOrderId))
      .select("*")
      .maybeSingle();

    if (updateErr) throw updateErr;
    if (updated) return res.json({ ok: true, mode: "updated", order: updated });

    const { data: inserted, error: insertErr } = await supabase.from("orders").insert([payload]).select("*").single();
    if (insertErr) throw insertErr;

    return res.json({ ok: true, mode: "inserted", order: inserted });
  } catch (err) {
    console.error("orders/confirm error:", err);
    return res.status(500).json({ ok: false, error: "Order confirm failed" });
  }
});

/* -----------------------
   Admin: list orders
   GET /admin/orders  (x-admin-token required)
------------------------ */
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const token = String(req.headers["x-admin-token"] || "").trim();
    const expected = String(process.env.ADMIN_TOKEN || "").trim();
    if (!expected || token !== expected) return res.status(401).json({ error: "unauthorized" });

    const cols = [
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
      "shipping_address",
      "square_transaction_id",
    ].join(",");

    const { data, error } = await supabase.from("orders").select(cols).order("created_at", { ascending: false }).limit(200);
    if (error) throw error;

    return res.json({ orders: data });
  } catch (err) {
    console.error("admin/orders error:", err);
    return res.status(500).json({ error: "db read failed" });
  }
});

/* -----------------------
   Square Setup (STRICT + DIAGNOSTICS)
------------------------ */
const RAW_ENV = String(process.env.SQUARE_ENV || "").trim().toLowerCase();
if (RAW_ENV !== "production" && RAW_ENV !== "sandbox") {
  console.error(`❌ SQUARE_ENV must be "production" or "sandbox" (got "${process.env.SQUARE_ENV}")`);
}

const SQUARE_ENV =
  RAW_ENV === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox;

const RAW_TOKEN = String(process.env.SQUARE_ACCESS_TOKEN || "");
const SQUARE_ACCESS_TOKEN = RAW_TOKEN.trim();
const SQUARE_LOCATION_ID = String(process.env.SQUARE_LOCATION_ID || "").trim();

const tokenHasWhitespace = /\s/.test(RAW_TOKEN);
const tokenLen = RAW_TOKEN.length;
const tokenLenTrim = SQUARE_ACCESS_TOKEN.length;

console.log("Square env:", RAW_ENV || "(missing)");
console.log("Square token:", mask(SQUARE_ACCESS_TOKEN));
console.log("Square token length:", tokenLen, "trimmed:", tokenLenTrim, "hasWhitespace:", tokenHasWhitespace);
console.log("Square location:", SQUARE_LOCATION_ID || "(missing)");

if (SQUARE_ACCESS_TOKEN.startsWith("sq0idp-")) {
  console.error("❌ Your SQUARE_ACCESS_TOKEN looks like an APPLICATION ID (sq0idp-...). Use an ACCESS TOKEN instead.");
}

if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.error("❌ Missing SQUARE_ACCESS_TOKEN and/or SQUARE_LOCATION_ID");
}

const squareClient = new SquareClient({
  environment: SQUARE_ENV,
  accessToken: SQUARE_ACCESS_TOKEN,
});

/**
 * GET /square/debug
 * Returns ONLY non-secret diagnostics so you can confirm Render is using what you think.
 */
app.get("/square/debug", (_req, res) => {
  res.json({
    ok: true,
    env: RAW_ENV || null,
    locationIdSet: Boolean(SQUARE_LOCATION_ID),
    tokenMasked: mask(SQUARE_ACCESS_TOKEN),
    tokenLength: tokenLen,
    tokenLengthTrimmed: tokenLenTrim,
    tokenHasWhitespace,
    tokenSha256: sha256(SQUARE_ACCESS_TOKEN), // fingerprint (safe)
  });
});

/* -----------------------
   Square Health
------------------------ */
app.get("/square/health", async (_req, res) => {
  try {
    const result = await squareClient.locations.list();
    const locations = result.result.locations || [];
    res.json({
      ok: true,
      env: RAW_ENV,
      locationsFound: locations.length,
      locationIdExistsInAccount: locations.some((l) => l.id === SQUARE_LOCATION_ID),
    });
  } catch (err) {
    console.error("Square health error:", err?.errors || err);
    res.status(500).json({ ok: false, env: RAW_ENV, error: err?.errors || err });
  }
});

/* -----------------------
   Square Checkout
------------------------ */
app.post("/square/create-checkout", async (req, res) => {
  try {
    const { total, returnUrl, cancelUrl } = req.body || {};
    if (!total || !returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing checkout fields (total, returnUrl, cancelUrl)" });
    }

    const cents = Math.round(Number(total) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }

    const response = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Order Total",
            quantity: "1",
            basePriceMoney: {
              amount: BigInt(cents), // Square expects bigint
              currency: "USD",
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: returnUrl,
        cancelUrl: cancelUrl,
      },
    });

    return res.json({ checkoutUrl: response.result.paymentLink.url });
  } catch (err) {
    console.error("Square checkout error:", err?.errors || err);
    return res.status(500).json({
      error: "Square create-checkout failed",
      details: err?.errors || err,
    });
  }
});

/* -----------------------
   Start Server
------------------------ */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
