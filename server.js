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
   Health
------------------------ */
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

/* -----------------------
   Supabase
------------------------ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* -----------------------
   Square Setup
------------------------ */
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV =
  process.env.SQUARE_ENV === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;

if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.error("❌ Missing Square environment variables");
}

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

    const hasLocation = locations.some(
      (loc) => loc.id === SQUARE_LOCATION_ID
    );

    res.json({
      ok: true,
      env: process.env.SQUARE_ENV,
      locationsFound: locations.length,
      locationIdExistsInAccount: hasLocation,
    });
  } catch (err) {
    console.error("Square health error:", err);
    res.status(500).json({
      ok: false,
      error: err?.errors || err?.message || err,
    });
  }
});

/* -----------------------
   Create Checkout
------------------------ */
app.post("/square/create-checkout", async (req, res) => {
  try {
    const { total, returnUrl, cancelUrl } = req.body;

    if (!total || !returnUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing checkout fields" });
    }

    const amount = Math.round(Number(total) * 100);
    if (!Number.isFinite(amount) || amount <= 0) {
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
              amount,
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

    res.json({
      checkoutUrl: response.result.paymentLink.url,
    });
  } catch (err) {
    console.error("Square checkout error:", err);
    res.status(500).json({
      error: "Square create-checkout failed",
      details: err?.errors || err?.message || err,
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
