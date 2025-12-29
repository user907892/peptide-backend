// server.js
// ArcticLabSupply backend (Render) — Stripe Checkout + Promotion Codes 

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();

// ✅ CORS (site + localhost)
const corsOptions = {
  origin: [
    "https://arcticlabsupply.com",
    "https://www.arcticlabsupply.com",
    "http://localhost:5173",
    "http://localhost:3000",
  ],
  methods: ["GET", "POST", "OPTIONS"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// ✅ Don't crash server if STRIPE_SECRET_KEY missing
let stripe = null;
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ Missing STRIPE_SECRET_KEY in environment variables.");
} else {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

function normalizeCoupon(code) {
  return String(code || "").trim().toUpperCase();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "ArcticLabSupply backend live" });
});

/**
 * Create Stripe Checkout Session
 * Accepts customer-facing Stripe Promotion Codes (e.g., SAVE10, TAKE10)
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not configured on the server",
        message: "Missing STRIPE_SECRET_KEY",
      });
    }

    const { items, shipping, coupon } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const line_items = [];

    for (const item of items) {
      if (!item || !item.id) continue;

      line_items.push({
        price: item.id,
        quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
      });
    }

    // Optional shipping as its own line item
    if (typeof shipping === "number" && shipping > 0) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Shipping" },
          unit_amount: Math.round(shipping * 100),
        },
        quantity: 1,
      });
    }

    if (line_items.length === 0) {
      return res.status(400).json({ error: "No valid line items" });
    }

    // ✅ Promotion code lookup by customer-entered code (SAVE10 / TAKE10)
    const normalizedCoupon = normalizeCoupon(coupon);

    let discounts;
    let appliedPromotionCodeId = null;

    if (normalizedCoupon) {
      const promos = await stripe.promotionCodes.list({
        code: normalizedCoupon,
        active: true,
        limit: 1,
      });

      if (!promos.data.length) {
        return res.status(400).json({ error: "Invalid coupon code" });
      }

      appliedPromotionCodeId = promos.data[0].id;
      discounts = [{ promotion_code: appliedPromotionCodeId }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      discounts: discounts || undefined,

      success_url:
        
"https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://arcticlabsupply.com/cart",

      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },

      // Helpful for tracking which code was used
      metadata: {
        source: "arcticlabsupply-cart",
        coupon_code: normalizedCoupon || "",
        promotion_code_id: appliedPromotionCodeId || "",
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err?.message || 
err);
    return res.status(500).json({
      error: "Failed to create checkout session",
      message: err?.message || "unknown error",
    });
  }
});

/**
 * Retrieve Stripe Checkout Session details (for GA4 purchase event)
 * GET /stripe/session?session_id=cs_test_...
 */
app.get("/stripe/session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not configured on the server",
        message: "Missing STRIPE_SECRET_KEY",
      });
    }

    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent", "line_items.data.price.product"],
    });

    const transaction_id =
      (typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id) || session.id;

    const value = (session.amount_total || 0) / 100;
    const currency = (session.currency || "usd").toUpperCase();

    const items =
      session.line_items?.data?.map((li) => {
        const price = li.price;
        const product = price?.product;

        return {
          item_id:
            (typeof product === "object" && product?.id) ||
            price?.id ||
            "unknown",
          item_name:
            (typeof product === "object" && product?.name) ||
            li.description ||
            "Item",
          price: (price?.unit_amount || 0) / 100,
          quantity: li.quantity || 1,
        };
      }) || [];

    return res.json({
      session_id: session.id,
      transaction_id,
      value,
      currency,
      items,
      coupon_code: session.metadata?.coupon_code || "",
      promotion_code_id: session.metadata?.promotion_code_id || "",
    });
  } catch (err) {
    console.error("Error retrieving session:", err?.message || err);
    return res.status(500).json({
      error: "Failed to retrieve session",
      message: err?.message || "unknown error",
    });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`ArcticLabSupply backend listening on port ${PORT}`);
});

