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
app.use(express.json());

/* -----------------------
   Health
------------------------ */
const SERVER_VERSION = "square-auth-diagnostics-1";

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Backend live", version: 
SERVER_VERSION });
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

/* -----------------------
   Orders: create (pre-checkout)
   POST /orders/create
------------------------ */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, message: "Supabase not 
configured" });
    }

    const body = req.body || {};
    const { orderId, items, totals, coupon, timestamp, shippingAddress } = 
body;

    if (!orderId) return res.status(400).json({ ok: false, message: 
"orderId required" });
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ ok: false, message: "items required" 
});
    if (!totals || typeof totals !== "object")
      return res.status(400).json({ ok: false, message: "totals required" 
});

    const payload = {
      order_id: String(orderId),
      items,
      totals,
      coupon: coupon || null,
      shipping_address: shippingAddress || null,
      client_timestamp: timestamp ? new Date(timestamp).toISOString() : 
null,
      status: "new",
      payment_status: "pending",
    };

    const { data, error } = await 
supabase.from("orders").insert([payload]).select("*").single();
    if (error) {
      console.error("orders/create insert error:", error);
      return res.status(500).json({ ok: false, message: "Supabase insert 
failed", error: error.message });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create crash:", err);
    return res.status(500).json({ ok: false, message: "Server error", 
details: String(err?.message || err) });
  }
});

/* -----------------------
   Orders: confirm (mark paid + attach shipping)
   POST /orders/confirm
------------------------ */
app.post("/orders/confirm", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, message: "Supabase not 
configured" });
    }

    const { orderId, transactionId, pendingOrder } = req.body || {};
    if (!pendingOrder) return res.status(400).json({ ok: false, message: 
"Missing pendingOrder payload" });

    const resolvedOrderId = orderId || pendingOrder.orderId;
    if (!resolvedOrderId) return res.status(400).json({ ok: false, 
message: "Missing orderId" });

    const totals = {
      sub: pendingOrder.subtotal ?? pendingOrder.sub ?? 0,
      discount: pendingOrder.discount ?? 0,
      shippingCost: pendingOrder.shippingCost ?? pendingOrder.shipping ?? 
0,
      total: pendingOrder.total ?? 0,
    };

    const shippingAddress = pendingOrder.shippingAddress || 
pendingOrder.shipping || null;

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

    if (updateErr) {
      console.error("orders/confirm update error:", updateErr);
      return res.status(500).json({ ok: false, message: "Supabase update 
failed", error: updateErr.message });
    }

    if (updated) return res.json({ ok: true, mode: "updated", order: 
updated });

    const { data: inserted, error: insertErr } = await 
supabase.from("orders").insert([payload]).select("*").single();
    if (insertErr) {
      console.error("orders/confirm insert error:", insertErr);
      return res.status(500).json({ ok: false, message: "Supabase insert 
failed", error: insertErr.message });
    }

    return res.json({ ok: true, mode: "inserted", order: inserted });
  } catch (err) {
    console.error("orders/confirm crash:", err);
    return res.status(500).json({ ok: false, message: "Server error", 
details: String(err?.message || err) });
  }
});

/* -----------------------
   Admin: list orders
   GET /admin/orders
------------------------ */
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not 
configured" });

    const token = String(req.headers["x-admin-token"] || "").trim();
    const expected = String(process.env.ADMIN_TOKEN || "").trim();

    if (!expected || token !== expected) return res.status(401).json({ 
error: "unauthorized" });

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
      "shipping_address",
      "square_transaction_id",
    ].join(",");

    const { data, error } = await 
supabase.from("orders").select(selectCols).order("created_at", { 
ascending: false }).limit(200);
    if (error) {
      console.error("admin/orders read error:", error);
      return res.status(500).json({ error: "db read failed", details: 
error.message });
    }

    return res.json({ orders: data });
  } catch (err) {
    console.error("admin/orders crash:", err);
    return res.status(500).json({ error: "server error", details: 
String(err?.message || err) });
  }
});

/* -----------------------
   Square (AUTH DIAGNOSTICS BUILT IN)
------------------------ */
const SQUARE_ACCESS_TOKEN = String(process.env.SQUARE_ACCESS_TOKEN || 
"").trim();
const SQUARE_LOCATION_ID = String(process.env.SQUARE_LOCATION_ID || 
"").trim();

// IMPORTANT: don’t default this silently. If you forget to set it on 
Render,
// you’ll accidentally talk to Sandbox forever.
const SQUARE_ENV_RAW = String(process.env.SQUARE_ENV || 
"").trim().toLowerCase();

function getSquareEnvironmentOrThrow() {
  if (SQUARE_ENV_RAW === "production") return 
SquareEnvironment.Production;
  if (SQUARE_ENV_RAW === "sandbox") return SquareEnvironment.Sandbox;

  // Make misconfig obvious instead of “mysterious unauthorized”
  throw new Error(`SQUARE_ENV must be "sandbox" or "production" (got 
"${process.env.SQUARE_ENV}")`);
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 8) return "********";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

let squareClient = null;
let squareEnvResolved = null;

try {
  squareEnvResolved = getSquareEnvironmentOrThrow();
  if (SQUARE_ACCESS_TOKEN) {
    squareClient = new SquareClient({
      environment: squareEnvResolved,
      accessToken: SQUARE_ACCESS_TOKEN,
    });
  }
} catch (e) {
  console.error("❌ Square init error:", e.message);
}

// Log config once at boot (safe)
console.log("Square config:", {
  env: SQUARE_ENV_RAW || "(missing)",
  token: maskToken(SQUARE_ACCESS_TOKEN),
  locationId: SQUARE_LOCATION_ID || "(missing)",
});

/**
 * GET /square/health
 * This is the fastest way to prove whether Render is actually using the 
right token/env.
 * It calls Square Locations API. If this returns UNAUTHORIZED, your 
credentials/env are wrong.
 */
app.get("/square/health", async (_req, res) => {
  try {
    if (!squareClient) {
      return res.status(500).json({
        ok: false,
        error: "Square not configured",
        env: SQUARE_ENV_RAW || null,
        token: maskToken(SQUARE_ACCESS_TOKEN) || null,
        locationId: SQUARE_LOCATION_ID || null,
      });
    }

    const resp = await squareClient.locations.list();
    const locations = resp?.result?.locations || [];
    const locationMatch = SQUARE_LOCATION_ID
      ? locations.some((l) => String(l.id) === String(SQUARE_LOCATION_ID))
      : null;

    return res.json({
      ok: true,
      env: SQUARE_ENV_RAW,
      token: maskToken(SQUARE_ACCESS_TOKEN),
      locationId: SQUARE_LOCATION_ID || null,
      locationsCount: locations.length,
      locationIdExistsInAccount: locationMatch,
    });
  } catch (err) {
    const squareErrors =
      err?.errors || err?.result?.errors || err?.response?.body?.errors || 
err?.cause?.errors || null;

    console.error("Square /square/health error:", squareErrors || 
err?.message || err);

    return res.status(500).json({
      ok: false,
      env: SQUARE_ENV_RAW || null,
      token: maskToken(SQUARE_ACCESS_TOKEN) || null,
      locationId: SQUARE_LOCATION_ID || null,
      error: "Square health check failed",
      details: squareErrors || err?.message || String(err),
    });
  }
});

app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!squareClient) {
      return res.status(500).json({
        error: "Square not configured",
        message: "Missing SQUARE_ACCESS_TOKEN or invalid SQUARE_ENV",
      });
    }
    if (!SQUARE_LOCATION_ID) {
      return res.status(500).json({
        error: "Square not configured",
        message: "Missing SQUARE_LOCATION_ID",
      });
    }

    const { total, currency = "USD", returnUrl, cancelUrl } = req.body || 
{};
    const amount = Number(total);

    if (!Number.isFinite(amount) || amount <= 0) return 
res.status(400).json({ error: "Invalid total" });
    if (!returnUrl || !cancelUrl) return res.status(400).json({ error: 
"Missing returnUrl/cancelUrl" });

    // Square expects an integer amount in the smallest currency unit.
    const cents = Math.round(amount * 100);
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
      checkoutOptions: {
        redirectUrl: returnUrl,
        // If your Square account/SDK supports it, include a cancel URL 
too.
        // Some Square surfaces ignore this; keeping it here costs 
nothing.
        cancelUrl: cancelUrl,
      },
    });

    const body = resp?.result ?? resp;
    const checkoutUrl =
      body?.paymentLink?.url ||
      body?.payment_link?.url ||
      body?.paymentLinkUrl ||
      body?.url;

    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkout URL returned", 
details: body || null });
    }

    return res.json({ checkoutUrl });
  } catch (err) {
    const squareErrors =
      err?.errors || err?.result?.errors || err?.response?.body?.errors || 
err?.cause?.errors || null;

    console.error("Square create-checkout error:", squareErrors || err);

    return res.status(500).json({
      error: "Square create-checkout failed",
      details: squareErrors || err?.message || String(err),
    });
  }
});

/* -----------------------
   Start server
------------------------ */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT} (version 
${SERVER_VERSION})`);
});

