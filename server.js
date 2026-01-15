"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { SquareClient, SquareEnvironment } = require("square");

dotenv.config();

const app = express();

/* ================= CORS ================= */
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
      return cb(new Error("CORS blocked"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-token"],
  })
);

app.options("*", cors());
app.use(express.json());

/* ================= HEALTH ================= */
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend live" });
});

/* ================= SUPABASE ================= */
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

/* ================= ORDERS ================= */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase not configured");

    const { items, totals, coupon, shipping, timestamp } = req.body;

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "items required" });

    const { data, error } = await supabase
      .from("orders")
      .insert({
        items,
        totals,
        coupon: coupon || null,
        shipping_address: shipping || null,
        client_timestamp: timestamp || null,
        status: "new",
        payment_status: "pending",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ ok: true, order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= ADMIN ================= */
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase not configured");

    if (req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ orders: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= SQUARE ================= */
const squareClient =
  process.env.SQUARE_ACCESS_TOKEN &&
  process.env.SQUARE_LOCATION_ID
    ? new SquareClient({
        environment:
          process.env.SQUARE_ENV === "production"
            ? SquareEnvironment.Production
            : SquareEnvironment.Sandbox,
        bearerAuthCredentials: {
          accessToken: process.env.SQUARE_ACCESS_TOKEN,
        },
      })
    : null;

app.post("/square/create-checkout", async (req, res) => {
  try {
    if (!squareClient) throw new Error("Square not configured");

    const total = Number(req.body.total);
    if (!Number.isFinite(total) || total <= 0)
      return res.status(400).json({ error: "Invalid total" });

    const cents = BigInt(Math.round(total * 100));

    const result = await squareClient.checkout.paymentLinks.create({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Order",
            quantity: "1",
            basePriceMoney: {
              amount: cents,
              currency: "USD",
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: req.body.returnUrl,
      },
    });

    const checkoutUrl = result?.result?.paymentLink?.url;
    if (!checkoutUrl) throw new Error("No checkout URL");

    res.json({ checkoutUrl });
  } catch (err) {
    console.error("Square error:", err);
    res.status(500).json({
      error: "Square checkout failed",
      details: err.message,
    });
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});

