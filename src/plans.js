// Subscription plans. Prices in AED per month, excluding 5% VAT. Payment-provider plan ids come from .env.
const PLANS = {
  trial:    { id: "trial",    name: "Free trial", price: 0,   users: 15,  leadsPerMonth: 5000,  days: 14 },
  free:     { id: "free",     name: "Starter",    price: 0,   users: 3,   leadsPerMonth: 300 },
  pro:      { id: "pro",      name: "Pro",        price: 299, users: 15,  leadsPerMonth: 5000,  rzpEnv: "RAZORPAY_PLAN_PRO" },
  business: { id: "business", name: "Business",   price: 799, users: 100, leadsPerMonth: 50000, rzpEnv: "RAZORPAY_PLAN_BUSINESS" },
};
const PAID = ["pro", "business"];
const GRACE_MS = 3 * 24 * 3600e3;

// The plan a company actually gets right now (trial and paid plans fall back to Starter when they lapse)
function effectivePlan(org, now = Date.now()) {
  if (!org) return PLANS.free;
  if (org.plan === "trial") return (org.trial_ends_at || 0) > now ? PLANS.trial : PLANS.free;
  if (PAID.includes(org.plan)) return (!org.paid_until || org.paid_until + GRACE_MS > now) ? PLANS[org.plan] : PLANS.free;
  return PLANS[org.plan] || PLANS.free;
}

module.exports = { PLANS, PAID, effectivePlan };
