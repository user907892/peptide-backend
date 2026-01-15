/ server.js
"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// Square SDK (new exports)
const { SquareClient, SquareEnvironment } = require("square");

const app = express();

// ---- CORS ----
const allowedOrigins = [
  "https://arcticlabsupply.com",
  "https://www.arcticlabsupply.com",
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("*", cors());
app.use(express.json());

// ---- Health ----
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Backend live" });
});

// ---- Square config ----
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = (process.env.SQUARE_ENV || "sandbox").toLowerCase();

function getSquareEnvironment() {
  return SQUARE_ENV === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;
}

const squareClient = SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      environment: getSquareEnvironment(),
      token: SQUARE_ACCESS_TOKEN,
    })
  : null;

/**
 * POST /square/create-checkout
 * Body:
 * {
 *   total: "19.94",
 *   currency: "USD",
 *   returnUrl: "https://.../square-success",
 *   cancelUrl: "https://.../cart"
 * }
 */
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

    // cents (number)
    const cents = Math.round(amount * 100);
    const idempotencyKey = crypto.randomUUID();

    // Create a payment link
    const response = await squareClient.checkoutApi.createPaymentLink({
      idempotencyKey,
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Order Total",
            quantity: "1",
            basePriceMoney: {
              amount: cents,
              currency,
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: returnUrl,
      },
    });

    const checkoutUrl = response?.result?.paymentLink?.url;
    if (!checkoutUrl) {
      return res.status(500).json({
        error: "No checkout URL returned",
        details: response?.result || null,
      });
    }

    return res.json({ checkoutUrl });
  } catch (err) {
    console.error("Square create-checkout error:", err?.errors || err);
    return res.status(500).json({
      error: "Square create-checkout failed",
      details: err?.errors || err?.message || "unknown",
    });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));

