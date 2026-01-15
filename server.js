"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { SquareClient, SquareEnvironment } = require("square");

// Load .env locally (Render injects env vars automatically)
dotenv.config();

const app = express();

// --------------------
// CORS
// --------------------
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

app.use(express.json());
app.options("*", cors());

// --------------------
// Health
// --------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

// --------------------
// Supabase
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Supabase env vars missing");
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// --------------------
// Create Order
// --------------------
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not 
configured" });

    const { items, totals, coupon, timestamp } = req.body;

    const { data, error } = await supabase
      .from("orders")
      .insert([
        {
          items,
          totals,
          coupon: coupon || null,
          client_timestamp: timestamp
            ? new Date(timestamp).toISOString()
            : null,
          status: "new",
        },
      ])
      .select("id, created_at")
      .single();

    if (error) throw error;

    res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create error:", err);
    res.status(500).json({ error: "db insert failed", details: err.message 
});
  }
});

// --------------------
// Admin Orders
// --------------------
app.get("/admin/orders", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not 
configured" });

    const token = req.headers["x-admin-token"];
    const expected = process.env.ADMIN_TOKEN;

    if (!expected || token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, created_at, items, totals, coupon, client_timestamp, status"
      )
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    res.json({ orders: data });
  } catch (err) {
    console.error("admin/orders error:", err);
    res.status(500).json({ error: "db read failed", details: err.message 
});
  }
});

// --------------------
// Square
// --------------------
const squareClient = process.env.SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      environment:
        process.env.SQUARE_ENV === "production"
          ? SquareEnvironment.Production
          : SquareEnvironment.Sandbox,
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
    })
  : null;

// --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});

