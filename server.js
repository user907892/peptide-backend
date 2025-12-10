const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Stripe secret key from Render environment
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ DEFAULT PRODUCT (Tirzepatide-RUO 10mg)
const DEFAULT_PRICE_ID = "price_1ScanFBb4lHMkptrVBOBoRdc";

// ✅ YOUR REAL, LIVE PRICE MAP
const priceInfo = {
  "price_1ScasMBb4lHMkptr4I8lR9wk": { amount: 8000, name: "Semax 10mg" },
  "price_1ScartBb4lHMkptrnPNzWGlE": { amount: 12900, name: "Semaglutide 
10mg" },
  "price_1ScarOBb4lHMkptrAMf8k9xA": { amount: 13900, name: "CJC-1295 (with 
DAC) 10mg" },
  "price_1ScaqtBb4lHMkptrhqHvm4hg": { amount: 7500, name: "CJC-1295 (no 
DAC) 5mg" },
  "price_1ScaqNBb4lHMkptrzUczdGLz": { amount: 7900, name: "Sermorelin 5mg" 
},
  "price_1Scaq2Bb4lHMkptr0tZIa7ze": { amount: 7500, name: "Melanotan II 
10mg" },
  "price_1ScapUBb4lHMkptrax7jYKP9": { amount: 7900, name: "BPC-157 5mg" },
  "price_1ScaoTBb4lHMkptrCL7aXtc7": { amount: 6000, name: "GHK-Cu 50mg" },
  "price_1ScanwBb4lHMkptrMgFVPecU": { amount: 14900, name: "Retatrutide 
20mg" },
  "price_1ScanFBb4lHMkptrVBOBoRdc": { amount: 9500, name: "Tirzepatide-RUO 
10mg" },
};

// ✅ SHIPPING SETTINGS
const FREE_THRESHOLD = 9900; // $99
const STANDARD_SHIP = 695;   // $6.95

function getShippingOptions(subtotalCents) {
  const deliveryEstimate = {
    minimum: { unit: "business_day", value: 5 },
    maximum: { unit: "business_day", value: 7 },
  };

  if (subtotalCents >= FREE_THRESHOLD) {
    return [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: 0, currency: "usd" },
          display_name: "Free Shipping ($99+)",
          delivery_estimate: deliveryEstimate,
        },
      },
    ];
  }

  return [
    {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount: STANDARD_SHIP, currency: "usd" },
        display_name: "Standard Shipping",
        delivery_estimate: deliveryEstimate,
      },
    },
  ];
}

function calculateSubtotalCents(items) {
  let subtotal = 0;
  for (const item of items) {
    const info = priceInfo[item.priceId];
    if (!info) throw new Error("Unknown price ID: " + item.priceId);
    subtotal += info.amount * (item.quantity || 1);
  }
  return subtotal;
}

// ✅ HEALTH CHECK
app.get("/", (req, res) => {
  res.send("✅ Arctic Lab backend is running.");
});

// ✅ CHECKOUT ROUTE
app.post("/create-checkout-session", async (req, res) => {
  try {
    let normalizedItems = [];

    if (Array.isArray(req.body.items)) {
      normalizedItems = req.body.items.map(item => ({
        priceId: item.price,
        quantity: item.quantity || 1,
      }));
    } else {
      normalizedItems = [{ priceId: DEFAULT_PRICE_ID, quantity: 1 }];
    }

    const subtotal = calculateSubtotalCents(normalizedItems);
    const shippingOptions = getShippingOptions(subtotal);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: normalizedItems.map(item => ({
        price: item.priceId,
        quantity: item.quantity,
      })),
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: shippingOptions,
      customer_creation: "always",
      phone_number_collection: { enabled: true },
      success_url: 
"https://arcticlabsupply.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://arcticlabsupply.com/cart",
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ SERVER START
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log("✅ Stripe backend running on port " + PORT);
});

