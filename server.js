k// server.js
// ArcticLabSupply backend (Render) — Stripe Checkout + coupon support
// ✅ What this does:
// - Creates Stripe Checkout Sessions from Price IDs you send from 
frontend
// - Optionally adds a Shipping line item
// - ✅ Applies a discount code SERVER-SIDE (so it works on backend, not 
just UI)
// - Returns /stripe/session details for GA4 purchase event

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();

/**
 * ✅ CORS
 * Add any other domains you use (staging, preview) to this list.
 */
app.use(
  cors({
    origin: [
      "https://arcticlabsupply.com",
      "https://www.arcticlabsupply.com",
      "http://localhost:5173",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(express.json());

/**
 * ✅ STRIPE_SECRET_KEY must be set in Render env vars
 * Example: sk_live_...
 */
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ Missing STRIPE_SECRET_KEY in environment variables.");
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * ✅ Coupon Code Map (YOUR codes -> Stripe Coupon IDs)
 *
 * IMPORTANT:
 * 1) Create the coupons in Stripe Dashboard first (Coupons)
 * 2) Copy the coupon IDs (coupon_XXXX...)
 * 3) Paste them here
 *
 * If you prefer Promotion Codes instead, ask and I'll adjust.
 */
const COUPON_MAP = {
  // Example:
  // SAVE15: "coupon_ABC123",       // $15 off
  // WELCOME10: "coupon_DEF456",    // 10% off
};

/**
 * Normalize coupon input
 */
function normalizeCoupon(code) {
  return String(code || "").trim().toUpperCase();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "ArcticLabSupply backend live" });
});

/**
 * Create Stripe Checkout Session
 *
 * Frontend should send:
 * {
 *   items: [{ id: "price_...", quantity: 1 }, ...],
 *   shipping: 0 or 9.95,
 *   coupon: "SAVE15" (optional)
 * }
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items, shipping, coupon } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // Build Stripe line items from Price IDs
    const line_items = [];
    for (const item of items) {
      if (!item || !item.id) continue;
      line_items.push({
        price: item.id,
        quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
      });
    }

    // Optional shipping as its own line item
    // NOTE: Coupons in Stripe may discount shipping depending on coupon 
settings.
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

    // ✅ Apply discount server-side (so backend reflects it)
    const normalizedCoupon = normalizeCoupon(coupon);

    // Stripe "discounts" accepts coupon IDs:
    // discounts: [{ coupon: "coupon_..." }]
    let discounts;
    if (normalizedCoupon) {
      const stripeCouponId = COUPON_MAP[normalizedCoupon];

      if (!stripeCouponId) {
        return res.status(400).json({ error: "Invalid coupon code" });
      }

      discounts = [{ coupon: stripeCouponId }];
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

      metadata: {
        source: "arcticlabsupply-cart",
        coupon: normalizedCoupon || "",
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
 * Returns value + currency + items[].
 *
 * GET /stripe/session?session_id=cs_test_...
 */
app.get("/stripe/session", async (req, res) => {
  try {
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
      coupon: session.metadata?.coupon || "",
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

