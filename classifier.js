// ─── SmartTax AI — Transaction Classifier ────────────────────────────────────
// Takes a raw Plaid transaction + user profile → returns deduction decision
//
// Output shape:
// {
//   isDeductible: true,
//   confidence: 0.94,           // 0–1
//   category: "Software & SaaS",
//   scheduleC_line: "18",
//   deductionPct: 1.0,          // 1.0 = 100%, 0.5 = meals cap, etc.
//   deductionAmount: 23.76,     // estimated tax savings in dollars
//   signals: [...],             // what drove the decision
//   status: "auto_confirmed"    // auto_confirmed | pending | ask_user
// }
// ─────────────────────────────────────────────────────────────────────────────

// ── Known business merchant map ───────────────────────────────────────────────
// merchant_name (lowercase) → { category, confidence, scheduleC, pct }
const MERCHANT_MAP = {
  // Software / SaaS
  "adobe":              { cat: "Software & Subscriptions", conf: 0.98, line: "18", pct: 1.0 },
  "figma":              { cat: "Software & Subscriptions", conf: 0.98, line: "18", pct: 1.0 },
  "notion":             { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "github":             { cat: "Software & Subscriptions", conf: 0.98, line: "18", pct: 1.0 },
  "canva":              { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "slack":              { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "zoom":               { cat: "Software & Subscriptions", conf: 0.96, line: "18", pct: 1.0 },
  "dropbox":            { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "google workspace":   { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "google one":         { cat: "Software & Subscriptions", conf: 0.85, line: "18", pct: 1.0 },
  "chatgpt":            { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "openai":             { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "anthropic":          { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "loom":               { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "linear":             { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "vercel":             { cat: "Cloud & Hosting",          conf: 0.98, line: "18", pct: 1.0 },
  "aws":                { cat: "Cloud & Hosting",          conf: 0.95, line: "18", pct: 1.0 },
  "amazon web services":{ cat: "Cloud & Hosting",          conf: 0.97, line: "18", pct: 1.0 },
  "digitalocean":       { cat: "Cloud & Hosting",          conf: 0.98, line: "18", pct: 1.0 },
  "netlify":            { cat: "Cloud & Hosting",          conf: 0.98, line: "18", pct: 1.0 },
  "squarespace":        { cat: "Software & Subscriptions", conf: 0.90, line: "18", pct: 1.0 },
  "shopify":            { cat: "Software & Subscriptions", conf: 0.90, line: "18", pct: 1.0 },
  "quickbooks":         { cat: "Software & Subscriptions", conf: 0.97, line: "18", pct: 1.0 },
  "linkedin":           { cat: "Marketing & Advertising",  conf: 0.88, line: "8",  pct: 1.0 },
  "mailchimp":          { cat: "Marketing & Advertising",  conf: 0.95, line: "8",  pct: 1.0 },
  "convertkit":         { cat: "Marketing & Advertising",  conf: 0.95, line: "8",  pct: 1.0 },

  // Hardware / Equipment
  "apple":              { cat: "Equipment & Hardware",     conf: 0.72, line: "13", pct: 1.0 }, // mixed
  "best buy":           { cat: "Equipment & Hardware",     conf: 0.70, line: "13", pct: 1.0 }, // mixed
  "b&h":                { cat: "Equipment & Hardware",     conf: 0.90, line: "13", pct: 1.0 },
  "adorama":            { cat: "Equipment & Hardware",     conf: 0.92, line: "13", pct: 1.0 },
  "amazon":             { cat: "Equipment & Hardware",     conf: 0.60, line: "13", pct: 1.0 }, // low — mixed

  // Internet / Phone
  "verizon":            { cat: "Phone & Internet",         conf: 0.75, line: "25", pct: 0.5 }, // partial biz
  "at&t":               { cat: "Phone & Internet",         conf: 0.75, line: "25", pct: 0.5 },
  "t-mobile":           { cat: "Phone & Internet",         conf: 0.75, line: "25", pct: 0.5 },
  "comcast":            { cat: "Phone & Internet",         conf: 0.80, line: "25", pct: 0.5 },
  "xfinity":            { cat: "Phone & Internet",         conf: 0.80, line: "25", pct: 0.5 },
  "spectrum":           { cat: "Phone & Internet",         conf: 0.80, line: "25", pct: 0.5 },

  // Transportation
  "uber":               { cat: "Travel & Transport",       conf: 0.65, line: "24a", pct: 1.0 }, // mixed
  "lyft":               { cat: "Travel & Transport",       conf: 0.65, line: "24a", pct: 1.0 },
  "delta":              { cat: "Travel & Transport",       conf: 0.72, line: "24a", pct: 1.0 },
  "united":             { cat: "Travel & Transport",       conf: 0.72, line: "24a", pct: 1.0 },
  "american airlines":  { cat: "Travel & Transport",       conf: 0.72, line: "24a", pct: 1.0 },
  "southwest":          { cat: "Travel & Transport",       conf: 0.72, line: "24a", pct: 1.0 },

  // Meals (50% cap)
  "doordash":           { cat: "Meals (50% deductible)",   conf: 0.55, line: "24b", pct: 0.5 },
  "uber eats":          { cat: "Meals (50% deductible)",   conf: 0.55, line: "24b", pct: 0.5 },
  "grubhub":            { cat: "Meals (50% deductible)",   conf: 0.55, line: "24b", pct: 0.5 },

  // Education
  "udemy":              { cat: "Education & Courses",      conf: 0.95, line: "27a", pct: 1.0 },
  "coursera":           { cat: "Education & Courses",      conf: 0.95, line: "27a", pct: 1.0 },
  "skillshare":         { cat: "Education & Courses",      conf: 0.95, line: "27a", pct: 1.0 },
  "masterclass":        { cat: "Education & Courses",      conf: 0.88, line: "27a", pct: 1.0 },

  // Freelance platforms
  "fiverr":             { cat: "Platform Fees",            conf: 0.97, line: "10", pct: 1.0 },
  "upwork":             { cat: "Platform Fees",            conf: 0.97, line: "10", pct: 1.0 },
  "toptal":             { cat: "Platform Fees",            conf: 0.97, line: "10", pct: 1.0 },
};

// ── Plaid personal_finance_category → SmartTax deduction category ─────────────
const PFC_MAP = {
  "GENERAL_SERVICES-INTERNET_AND_TELEPHONE":    { cat: "Phone & Internet",        conf: 0.80, line: "25", pct: 0.5 },
  "GENERAL_SERVICES-POSTAGE_AND_SHIPPING":      { cat: "Office Supplies",         conf: 0.75, line: "18", pct: 1.0 },
  "TRANSPORTATION-TAXIS_AND_RIDE_SHARING":      { cat: "Travel & Transport",      conf: 0.65, line: "24a", pct: 1.0 },
  "TRANSPORTATION-PUBLIC_TRANSIT":              { cat: "Travel & Transport",      conf: 0.65, line: "24a", pct: 1.0 },
  "TRANSPORTATION-AIRLINES":                    { cat: "Travel & Transport",      conf: 0.72, line: "24a", pct: 1.0 },
  "TRAVEL-LODGING":                             { cat: "Travel & Transport",      conf: 0.72, line: "24a", pct: 1.0 },
  "FOOD_AND_DRINK-RESTAURANT":                  { cat: "Meals (50% deductible)",  conf: 0.52, line: "24b", pct: 0.5 },
  "GENERAL_MERCHANDISE-ELECTRONICS":            { cat: "Equipment & Hardware",    conf: 0.65, line: "13", pct: 1.0 },
  "GENERAL_SERVICES-ACCOUNTING_AND_FINANCIAL":  { cat: "Professional Services",   conf: 0.90, line: "17", pct: 1.0 },
  "GENERAL_SERVICES-LEGAL":                     { cat: "Professional Services",   conf: 0.90, line: "17", pct: 1.0 },
  "GENERAL_SERVICES-EDUCATION":                 { cat: "Education & Courses",     conf: 0.82, line: "27a", pct: 1.0 },
  "GENERAL_SERVICES-ADVERTISING_AND_MARKETING": { cat: "Marketing & Advertising", conf: 0.88, line: "8",  pct: 1.0 },
  "GENERAL_SERVICES-COMPUTER_PROGRAMMING":      { cat: "Software & Subscriptions",conf: 0.90, line: "18", pct: 1.0 },
};

// ── Freelance type → expected high-value categories ───────────────────────────
const PROFILE_BOOSTS = {
  "content_creator":  ["Equipment & Gear", "Software & Subscriptions", "Platform Fees"],
  "designer":         ["Software & Subscriptions", "Equipment & Hardware", "Font & Asset Licenses"],
  "developer":        ["Software & Subscriptions", "Cloud & Hosting", "Equipment & Hardware"],
  "writer":           ["Software & Subscriptions", "Research & Books"],
  "photographer":     ["Equipment & Gear", "Editing Software", "Travel & Transport"],
  "consultant":       ["Travel & Transport", "Meals (50% deductible)", "Software & Subscriptions"],
};

// ── Personal / clearly non-deductible merchants ───────────────────────────────
const PERSONAL_MERCHANTS = new Set([
  "netflix", "spotify", "hulu", "disney", "hbo", "max", "apple tv",
  "starbucks", "chipotle", "mcdonald", "chick-fil-a", "whole foods",
  "target", "walmart", "costco", "walgreens", "cvs",
  "planet fitness", "equinox", "peloton",
  "venmo", "zelle", "cash app", // peer transfers
]);

// ─────────────────────────────────────────────────────────────────────────────
// classify(transaction, userProfile) → DeductionDecision
// ─────────────────────────────────────────────────────────────────────────────
function classify(transaction, userProfile) {
  const {
    merchant_name,
    name,
    amount,
    personal_finance_category,
    payment_channel,
  } = transaction;

  const merchantRaw = (merchant_name || name || "").toLowerCase().trim();
  const signals     = [];
  let confidence    = 0;
  let category      = null;
  let line          = "27a";
  let deductionPct  = 1.0;

  // ── Signal 1: Known personal merchant → reject immediately ───────────────
  for (const personal of PERSONAL_MERCHANTS) {
    if (merchantRaw.includes(personal)) {
      return {
        isDeductible:   false,
        confidence:     0.95,
        category:       null,
        deductionPct:   0,
        deductionAmount: 0,
        signals:        [`Known personal merchant: ${merchantRaw}`],
        status:         "rejected",
      };
    }
  }

  // ── Signal 2: Exact merchant match ───────────────────────────────────────
  for (const [key, val] of Object.entries(MERCHANT_MAP)) {
    if (merchantRaw.includes(key)) {
      confidence   = val.conf;
      category     = val.cat;
      line         = val.line;
      deductionPct = val.pct;
      signals.push(`Merchant match: "${key}" → ${category} (${Math.round(val.conf * 100)}%)`);
      break;
    }
  }

  // ── Signal 3: Plaid personal_finance_category ─────────────────────────────
  if (personal_finance_category?.detailed) {
    const pfcKey = personal_finance_category.detailed.toUpperCase();
    if (PFC_MAP[pfcKey]) {
      const pfc = PFC_MAP[pfcKey];
      signals.push(`Plaid category: ${pfcKey} (${Math.round(pfc.conf * 100)}%)`);
      if (!category) {
        // No merchant match yet — use PFC as primary signal
        category     = pfc.cat;
        line         = pfc.line;
        deductionPct = pfc.pct;
        confidence   = pfc.conf;
      } else {
        // Corroborate or discount existing signal
        const delta = pfc.conf > 0.7 ? 0.05 : -0.05;
        confidence  = Math.min(0.99, confidence + delta);
      }
    }
  }

  // ── Signal 4: Profile boost (user's freelance type matches category) ──────
  if (category && userProfile?.freelanceTypes) {
    for (const type of userProfile.freelanceTypes) {
      const boosts = PROFILE_BOOSTS[type] || [];
      if (boosts.some((b) => category.toLowerCase().includes(b.toLowerCase()))) {
        confidence = Math.min(0.99, confidence + 0.04);
        signals.push(`Profile boost: ${type} commonly deducts ${category}`);
        break;
      }
    }
  }

  // ── Signal 5: Amount signals ──────────────────────────────────────────────
  if (amount > 0 && amount < 1) {
    confidence = Math.max(0, confidence - 0.1); // micro-amounts are suspicious
    signals.push("Small amount — confidence reduced");
  }
  if (amount > 5000) {
    signals.push("Large amount — flagged for user review");
    confidence = Math.min(confidence, 0.75); // cap confidence on big purchases
  }

  // ── Signal 6: Payment channel ─────────────────────────────────────────────
  if (payment_channel === "online" && category) {
    confidence = Math.min(0.99, confidence + 0.02);
    signals.push("Online payment (SaaS/subscription pattern)");
  }

  // ── No category found → not deductible ───────────────────────────────────
  if (!category || confidence < 0.3) {
    return {
      isDeductible:    false,
      confidence:      confidence || 0.2,
      category:        null,
      deductionPct:    0,
      deductionAmount: 0,
      signals:         signals.length ? signals : ["No deductible pattern detected"],
      status:          "ask_user",
    };
  }

  // ── Calculate estimated tax savings ──────────────────────────────────────
  // Use user's inferred marginal rate (federal + SE + state)
  const effectiveRate = inferEffectiveRate(userProfile);
  const deductionAmount = parseFloat(
    (amount * deductionPct * effectiveRate).toFixed(2)
  );

  // ── Determine status based on confidence ─────────────────────────────────
  let status;
  if (confidence >= 0.85)      status = "auto_confirmed";
  else if (confidence >= 0.50) status = "pending";
  else                         status = "ask_user";

  return {
    isDeductible:    true,
    confidence:      parseFloat(confidence.toFixed(3)),
    category,
    scheduleC_line:  line,
    deductionPct,
    deductionAmount,
    effectiveRate,
    signals,
    status,
  };
}

// ── Infer user's combined marginal tax rate ───────────────────────────────────
function inferEffectiveRate(profile = {}) {
  const { freelanceIncome, filingStatus, state, w2Income } = profile;

  // SE tax deduction: you deduct half of SE tax (7.65%) from gross
  const seTaxRate   = 0.1413; // 15.3% × 0.9235 (SE deduction applied)
  const annualIncome = (freelanceIncome || 4000) * 12 + (w2Income || 0);

  // Simplified federal marginal bracket inference (2024 single)
  let federalRate;
  if (annualIncome < 11600)       federalRate = 0.10;
  else if (annualIncome < 47150)  federalRate = 0.12;
  else if (annualIncome < 100525) federalRate = 0.22;
  else if (annualIncome < 191950) federalRate = 0.24;
  else                            federalRate = 0.32;

  // State rate lookup (approximate)
  const STATE_RATES = {
    CA: 0.093, NY: 0.0685, NJ: 0.0637, OR: 0.099, MN: 0.0985,
    TX: 0, FL: 0, NV: 0, WA: 0, WY: 0,
    IL: 0.0495, MA: 0.05, CO: 0.044, AZ: 0.025, GA: 0.055,
  };
  const stateRate = STATE_RATES[state?.toUpperCase()] ?? 0.05; // default 5%

  // Combined marginal rate on a deductible expense
  return parseFloat((federalRate + stateRate).toFixed(4));
  // Note: SE tax reduction is handled separately as it affects self-employed income deduction
}

// ── IRS limit flags ───────────────────────────────────────────────────────────
function checkLimits(category, ytdTotal, newAmount) {
  const flags = [];
  if (category === "Meals (50% deductible)") {
    flags.push({ type: "cap", message: "Meals are 50% deductible per IRS rules" });
  }
  if (category === "Education & Courses" && ytdTotal + newAmount > 5000) {
    flags.push({ type: "warning", message: "Large education expense — keep receipts" });
  }
  return flags;
}

module.exports = { classify, inferEffectiveRate, checkLimits, MERCHANT_MAP };
