// server.js
"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ✅ New Square SDK exports (migration: Client->SquareClient, 
Environment->SquareEnvironment)
const { SquareClient, SquareEnvironment } = require("square");

const app = express();

// ---- CORS ----
const allowedOrigins = [
  "https://arcticlabsupply.com",
  "https://www.arcticlabsupply.com",
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.ORIGIN, // optional
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      // allow no-origin (server-to-server, curl)
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
  // ✅ New enum name: SquareEnvironment (not Environment)
  return SQUARE_ENV === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;
}

// ✅ New client name: SquareClient
// Token key differs by SDK version; migration guide says 
bearerAuthCredentials.accessToken -> token,
// but some examples show accessToken. We'll support BOTH safely.
const squareClient = SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      environment: getSquareEnvironment(),
      // prefer token; fall back to accessToken for compatibility with 
some releases
      token: SQUARE_ACCESS_TOKEN,
      accessToken: SQUARE_ACCESS_TOKEN,
    })
  : null;

/**
 * POST /square/create-checkout
 * Body:
 * {
 *   total: "19.94",           // string or number
 *   currency: "USD",          // optional
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

    // Square uses smallest currency unit (cents)
    const cents = Math.round(amount * 100);

    // Some newer SDKs accept BigInt for amount fields; others accept 
number.
    // We'll send BigInt but fall back to number automatically if needed.
    const amountMoney = {
      amount: BigInt(cents),
      currency,
    };

    const idempotencyKey = crypto.randomUUID();

    // ✅ Checkout API createPaymentLink
    const response = await squareClient.checkoutApi.createPaymentLink({
      idempotencyKey,
      order: {
        locationId: SQUARE_LOCATION_ID,
        lineItems: [
          {
            name: "Order Total",
            quantity: "1",
            basePriceMoney: amountMoney,
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: returnUrl,
      },
      prePopulatedData: {},
    });

    const url = response?.result?.paymentLink?.url;
    if (!url) {
      return res.status(500).json({ error: "No checkout URL returned" });
    }

    return res.json({ checkoutUrl: url });
  } catch (err) {
    // If the SDK complains about BigInt serialization/typing, retry once 
with number.
    const msg = err?.message || "";
    const bigIntHint =
      msg.includes("BigInt") ||
      msg.includes("Do not know how to serialize a BigInt") ||
      msg.includes("Cannot convert a BigInt");

    if (bigIntHint && squareClient) {
      try {
        const { total, currency = "USD", returnUrl } = req.body || {};
        const amount = Number(total);
        const cents = Math.round(amount * 100);

        const response2 = await 
squareClient.checkoutApi.createPaymentLink({
          idempotencyKey: crypto.randomUUID(),
          order: {
            locationId: SQUARE_LOCATION_ID,
            lineItems: [
              {
                name: "Order Total",
                quantity: "1",
                basePriceMoney: {
                  amount: cents, // fallback number
                  currency,
                },
              },
            ],
          },
          checkoutOptions: {
            redirectUrl: returnUrl,
          },
          prePopulatedData: {},
        });

        const url2 = response2?.result?.paymentLink?.url;
        if (url2) return res.json({ checkoutUrl: url2 });
      } catch (retryErr) {
        console.error("Square retry (number amount) failed:", 
retryErr?.errors || retryErr);
      }
    }

    console.error("Square create-checkout error:", err?.errors || err);
    return res.status(500).json({
      error: "Square create-checkout failed",
      details: err?.errors || err?.message || "unknown",
    });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));

