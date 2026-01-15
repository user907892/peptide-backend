"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { SquareClient, SquareEnvironment } = require("square");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* -----------------------
   Health
------------------------ */
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

/* -----------------------
   Supabase
------------------------ */
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* -----------------------
   Orders: create
------------------------ */
app.post("/orders/create", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { orderId, items, totals, shippingAddress } = req.body || {};
    if (!orderId || !items || !totals) {
      return res.status(400).json({ error: "Missing order data" });
    }

    const payload = {
      order_id: String(orderId),
      items,
      totals,
      shipping_address: shippingAddress || null,
      status: "new",
      payment_status: "pending",
    };

    const { data, error } = await supabase.from("orders").insert([payload]).select("*").single();
    if (error) throw error;

    res.json({ ok: true, order: data });
  } catch (err) {
    console.error("orders/create error:", err);
    res.status(500).json({ error: "Order create failed" });
  }
});

/* -----------------------
   Square Setup
------------------------ */
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_ENV =
  process.env.SQUARE_ENV === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;

const squareClient = new SquareClient({
  environment: SQUARE_ENV,
  accessToken: SQUARE_ACCESS_TOKEN,
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
      locationsFound: locations.length,
      locationIdExistsInAccount: locations.some(l => l.id === SQUARE_LOCATION_ID),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.errors || err });
  }
});

/* -----------------------
   Square Checkout
------------------------ */
app.post("/square/create-checkout", async (req, res) => {
  try {
    const { total, returnUrl, cancelUrl } = req.body || {};
    if (!total || !returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing checkout fields" });
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
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: returnUrl,
        cancelUrl: cancelUrl,
      },
    });

    res.json({ checkoutUrl: response.result.paymentLink.url });
  } catch (err) {
    console.error("Square checkout error:", err?.errors || err);
    res.status(500).json({
      error: "Square create-checkout failed",
      details: err?.errors || err,
    });
  }
});

/* -----------------------
   Start Server
------------------------ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
