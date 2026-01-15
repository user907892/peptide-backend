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
   Middleware
------------------------ */
app.use(cors());
app.use(express.json());

/* -----------------------
   Basic health
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
    if (!supabase) {
      return res.status(500).json({ ok: false, message: "Supabase not configured" });
    }

    const body = req.body || {};
    const { orderId, items, totals, coupon, timestamp, shippingAddress } = body;

    if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, message: "items required" });
    }
    if (!totals || typeof totals !== "object") {
      return res.status(400).json({ ok: false, message: "totals required" });
    }

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

    if (error) {
      console.error("orders/create insert error:", error);
      return res.status(500).json({
        ok: false,
        message: "Supabase insert failed",
        error: error.message,
      });
    }

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create crash:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
      details: String(err?.message || err),
    });
  }
});

/* -----------------------
   Orders: confirm
   POST /orders/confirm
------------------------ */
app.post("/orders/confirm", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, message: "Supabase not configured" });
    }

    const { orderId, transactionId, pendingOrder } = req.body || {};
    if (!pendingOrder) {
      return res.status(400).json({ ok: false, message: "Missing pendingOrder payload" });
    }

    const resolvedOrderId = orderId || pendingOrder.orderId;
    if (!resolvedOrderId) {
      return res.status(400).json({ ok: false, message: "Missing orderId" });
    }

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

    if (updateErr) {
      console.error("orders/confirm update error:", updateErr);
      return res.status(500).json({
        ok: false,
        message: "Supabase update failed",
        error: updateErr.message,
      });
    }

    if (updated) return res.json({ ok: true, mode: "updated", order: updated });

    const { data: inserted, error: insertErr } = await supabase
      .from("orders")
      .insert([payload])
      .select("*")
      .single();

    if (insertErr) {
      console.error("orders/confirm insert error:", insertErr);
      return res.status(500).json({
        ok: false,
        message: "Supabase insert failed",
        error: insertErr.message,
      });
    }

    return res.json({ ok: true, mode: "inserted", order: inserted });
  } catch (err) {
    console.error("orders/confirm crash:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
      details: String(err?.message || err),
    });
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

    const { data, error } = await supabase
      .from("orders")
      .select(cols)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("admin/orders read error:", error);
      return res.status(500).json({ error: "db read failed", details: error.message });
    }

    return res.json({ orders: data });
  } catch (err) {
    console.error("admin/orders crash:", err);
    return res.status(500).json({ error: "server error", details: String(err?.message || err) });
  }
});

/* -----------------------
   Square Setup
------------------------ */
const SQUARE_ACCESS_TOKEN = String(process.env.SQUARE_ACCESS_TOKEN || "").trim();
const SQUARE_LOCATION_ID = String(process.env.SQUARE_LOCATION_ID || "").trim();
const SQUARE_ENV_RAW = String(process.env.SQUARE_ENV || "sandbox").trim().toLowerCase();

const SQUARE_ENV =
  SQUARE_ENV_RAW === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;

const squareClient = new SquareClient({
  environment: SQUARE_ENV,
  accessToken: SQUARE_ACCESS_TOKEN,
});

/* -----------------------
   Square Health Check
------------------------ */
app.get("/square/health", async (_req, res) => {
  try {
    const response = await squareClient.locations.list();
    const locations = response.result.locations || [];

    const hasLocation = SQUARE_LOCATION_ID
      ? locations.some((loc) => loc.id === SQUARE_LOCATION_ID)
      : null;

    res.json({
      ok: true,
      env: SQUARE_ENV_RAW,
      locationsFound: locations.length,
      locationIdExistsInAccount: hasLocation,
    });
  } catch (err) {
    console.error("Square health error:", err?.errors || err);
    res.status(500).json({
      ok: false,
      env: SQUARE_ENV_RAW,
      error: err?.errors || err?.message || err,
    });
  }
});

/* -----------------------
   Create Checkout
------------------------ */
app.post("/square/create-checkout", async (req, res) => {
  try {
    const { total, returnUrl, cancelUrl } = req.body || {};

    if (!total || !returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing checkout fields (total, returnUrl, cancelUrl)" });
    }

    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res.status(500).json({ error: "Square not configured on server (missing env vars)" });
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
	  amount: BigInt(cents),
 	 currency: "USD",
	}
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
      details: err?.errors || err?.message || err,
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
