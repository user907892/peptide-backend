
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
app.get("/", (req, res) => {
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
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const body = req.body || {};
    const items = body.items;
    const totals = body.totals;
    const coupon = body.coupon;
    const timestamp = body.timestamp;

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
      .select("id, created_at, items, totals, coupon, client_timestamp, status")
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
   Square
------------------------ */
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
  console.log(`✅ Backend listening on ${PORT}`);
});

