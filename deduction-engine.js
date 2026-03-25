// ─── SmartTax AI — Deduction Engine & Webhook Pipeline ───────────────────────
// This is the real-time core of Feature 02.
// Plaid webhook fires → classify transaction → optimistically add to deduction
// tally → recalculate Tax Health Score → push notification to user
//
// npm install express plaid dotenv pg jsonwebtoken jose node-fetch
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express    = require("express");
const { Pool }   = require("pg");
const jwt        = require("jsonwebtoken");
const { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } = require("plaid");
const { classify, checkLimits } = require("./classifier");

const app = express();

// Webhook needs raw body for Plaid signature verification
app.use("/api/plaid/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Plaid ─────────────────────────────────────────────────────────────────────
const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "production"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET":    process.env.PLAID_SECRET,
    },
  },
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = payload.sub || payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK — POST /api/plaid/webhook
// Entry point for all real-time transaction events
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/plaid/webhook", async (req, res) => {
  // Verify Plaid signature
  const token = req.headers["plaid-verification"];
  if (!token) return res.status(400).json({ error: "Missing Plaid-Verification header" });

  // In production: full JWKS verification
  // const { jwtVerify, createRemoteJWKSet } = require("jose");
  // const JWKS = createRemoteJWKSet(new URL("https://production.plaid.com/openid/configuration"));
  // await jwtVerify(token, JWKS);

  res.sendStatus(200); // ACK immediately — Plaid requires fast response

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return;
  }

  const { webhook_type, webhook_code, item_id } = payload;
  console.log(`[webhook] ${webhook_type}/${webhook_code} — item ${item_id}`);

  if (webhook_type === "TRANSACTIONS" &&
    ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(webhook_code)
  ) {
    const row = await db.query(
      "SELECT user_id, access_token FROM plaid_items WHERE item_id = $1",
      [item_id]
    ).catch(() => ({ rows: [] }));

    if (!row.rows.length) return;
    const { user_id, access_token } = row.rows[0];

    // Run the full pipeline: fetch → classify → store → score → notify
    await runDeductionPipeline(user_id, access_token, item_id);
  }

  if (webhook_type === "ITEM" && webhook_code === "ERROR") {
    // User needs to re-authenticate — send them a push notification
    const row = await db.query(
      "SELECT user_id FROM plaid_items WHERE item_id = $1", [item_id]
    ).catch(() => ({ rows: [] }));
    if (row.rows.length) {
      await sendPushNotification(row.rows[0].user_id, {
        title: "Reconnect your bank",
        body: "Your bank connection needs a refresh to keep finding deductions.",
        type: "RECONNECT_REQUIRED",
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// runDeductionPipeline — the full Plaid → classify → store → score → notify flow
// ─────────────────────────────────────────────────────────────────────────────
async function runDeductionPipeline(userId, accessToken, itemId) {
  try {
    // 1. Fetch new transactions via cursor-based sync
    const { added, modified, removed } = await syncTransactions(accessToken, itemId);
    if (!added.length && !modified.length && !removed.length) return;

    // 2. Load user profile for personalized classification
    const profile = await getUserProfile(userId);

    // 3. Process each new transaction
    const deductionEvents = [];
    for (const tx of added) {
      if (tx.pending) continue; // wait for posted transactions only

      const decision = classify(tx, profile);
      const limits   = checkLimits(
        decision.category,
        await getCategoryYTD(userId, decision.category),
        tx.amount
      );

      // Store transaction with deduction decision
      await storeTransaction(userId, itemId, tx, decision, limits);

      if (decision.isDeductible) {
        deductionEvents.push({ tx, decision, limits });
      }
    }

    // 4. Handle removed transactions (user rejected or Plaid removed)
    for (const removed_tx of removed) {
      await db.query(
        `UPDATE transactions
         SET user_confirmed = false, deduction_amount = 0, updated_at = NOW()
         WHERE plaid_transaction_id = $1 AND user_id = $2`,
        [removed_tx.transaction_id, userId]
      );
    }

    // 5. Recalculate Tax Health Score
    await recalculateTaxHealthScore(userId);

    // 6. Fire push notifications (max 2/day per spec, prefer 1)
    if (deductionEvents.length > 0) {
      await fireDeductionNotifications(userId, deductionEvents);
    }

    console.log(`[pipeline] ${userId}: +${deductionEvents.length} deductions processed`);
  } catch (err) {
    console.error(`[pipeline] Error for ${userId}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plaid transactions/sync — cursor-based, only fetches what's new
// ─────────────────────────────────────────────────────────────────────────────
async function syncTransactions(accessToken, itemId) {
  const cursorRow = await db.query(
    "SELECT cursor FROM plaid_items WHERE item_id = $1", [itemId]
  );
  let cursor  = cursorRow.rows[0]?.cursor || null;
  let added = [], modified = [], removed = [];
  let hasMore = true;

  while (hasMore) {
    const res = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      options: { include_personal_finance_category: true },
    });
    added.push(...res.data.added);
    modified.push(...res.data.modified);
    removed.push(...res.data.removed);
    hasMore = res.data.has_more;
    cursor  = res.data.next_cursor;
  }

  await db.query(
    "UPDATE plaid_items SET cursor = $1, updated_at = NOW() WHERE item_id = $2",
    [cursor, itemId]
  );

  return { added, modified, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// storeTransaction — write to DB with full deduction metadata
// ─────────────────────────────────────────────────────────────────────────────
async function storeTransaction(userId, itemId, tx, decision, limits = []) {
  await db.query(`
    INSERT INTO transactions (
      plaid_transaction_id, user_id, item_id, account_id,
      amount, date, merchant_name, name, payment_channel,
      plaid_category_primary, plaid_category_detailed,
      is_deductible, confidence_score, deduction_category,
      schedule_c_line, deduction_pct, deduction_amount,
      tax_rate_applied, classification_signals, limit_flags,
      user_confirmed, status, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
      $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
      NOW(), NOW()
    )
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      deduction_category = EXCLUDED.deduction_category,
      confidence_score   = EXCLUDED.confidence_score,
      deduction_amount   = EXCLUDED.deduction_amount,
      status             = EXCLUDED.status,
      updated_at         = NOW()
  `, [
    tx.transaction_id,
    userId,
    itemId,
    tx.account_id,
    tx.amount,
    tx.date,
    tx.merchant_name || null,
    tx.name,
    tx.payment_channel || null,
    tx.personal_finance_category?.primary || null,
    tx.personal_finance_category?.detailed || null,
    decision.isDeductible,
    decision.confidence,
    decision.category || null,
    decision.scheduleC_line || null,
    decision.deductionPct || 0,
    decision.deductionAmount || 0,
    decision.effectiveRate || 0,
    JSON.stringify(decision.signals || []),
    JSON.stringify(limits),
    decision.status === "auto_confirmed" ? true : null, // null = pending
    decision.status,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tax Health Score — Phase 2 calculation
// ─────────────────────────────────────────────────────────────────────────────
async function recalculateTaxHealthScore(userId) {
  const profile = await getUserProfile(userId);
  const now     = new Date();
  const ytdStart = `${now.getFullYear()}-01-01`;

  // Component 1: Deduction Coverage (0–30)
  const deductionRow = await db.query(`
    SELECT
      SUM(CASE WHEN user_confirmed = true  THEN deduction_amount ELSE 0 END) AS confirmed,
      SUM(CASE WHEN user_confirmed IS NULL AND status = 'pending'
               THEN deduction_amount * 0.7 ELSE 0 END)                       AS pending_weighted
    FROM transactions
    WHERE user_id = $1 AND date >= $2 AND is_deductible = true
  `, [userId, ytdStart]);

  const confirmed        = parseFloat(deductionRow.rows[0]?.confirmed || 0);
  const pendingWeighted  = parseFloat(deductionRow.rows[0]?.pending_weighted || 0);
  const totalLogged      = confirmed + pendingWeighted;

  // Expected annual deductions prorated to current date
  const dayOfYear    = Math.ceil((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const expectedYTD  = (profile.expectedAnnualDeductions || 8000) * (dayOfYear / 365);
  const coverageRatio = expectedYTD > 0 ? Math.min(1, totalLogged / expectedYTD) : 0;
  const comp1        = Math.round(coverageRatio * 30);

  // Component 2: Set-Aside Behavior (0–25)
  const setAsideRow = await db.query(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM tax_set_asides WHERE user_id = $1 AND date >= $2",
    [userId, ytdStart]
  );
  const setAside         = parseFloat(setAsideRow.rows[0]?.total || 0);
  const estimatedLiability = calculateEstimatedLiability(profile, confirmed);
  const setAidePct        = estimatedLiability > 0 ? setAside / estimatedLiability : 0;
  let comp2;
  if (setAidePct >= 1.0)      comp2 = 25;
  else if (setAidePct >= 0.8) comp2 = 20;
  else if (setAidePct >= 0.6) comp2 = 14;
  else if (setAidePct >= 0.4) comp2 = 8;
  else                        comp2 = 3;

  // Deadline proximity penalty
  const nextDeadline   = getNextQuarterlyDeadline();
  const daysToDeadline = Math.ceil((nextDeadline - now) / 86400000);
  if (daysToDeadline < 30 && setAidePct < 0.8)  comp2 = Math.max(0, comp2 - 3);
  if (daysToDeadline < 15 && setAidePct < 0.8)  comp2 = Math.max(0, comp2 - 3);

  // Component 3: Profile Completeness (0–15)
  const comp3 = calculateProfileCompleteness(profile);

  // Component 4: Quarterly Deadline Awareness (0–20)
  let comp4 = 20;
  const paymentRow = await db.query(
    "SELECT MAX(payment_date) AS last_payment FROM quarterly_payments WHERE user_id = $1",
    [userId]
  );
  const lastPayment = paymentRow.rows[0]?.last_payment;
  if (daysToDeadline < 60 && setAidePct < 0.8)    comp4 = 17;
  if (daysToDeadline < 30 && setAidePct < 0.8)    comp4 = 12;
  if (daysToDeadline < 15 && !lastPayment)         comp4 = 6;
  if (daysToDeadline < 0  && !lastPayment)         comp4 = 2;

  // Component 5: Engagement (0–10)
  const engagementRow = await db.query(`
    SELECT
      MAX(last_opened_at)         AS last_open,
      MAX(last_deduction_action)  AS last_action,
      COUNT(CASE WHEN user_confirmed IS NOT NULL
                  AND updated_at > NOW() - INTERVAL '30 days'
                  THEN 1 END)     AS recent_reviews
    FROM user_engagement WHERE user_id = $1
  `, [userId]);
  const eng     = engagementRow.rows[0] || {};
  let comp5 = 0;
  const lastOpen   = eng.last_open   ? (now - new Date(eng.last_open))   / 86400000 : 999;
  const lastAction = eng.last_action ? (now - new Date(eng.last_action)) / 86400000 : 999;
  if (lastOpen < 7)    comp5 += 3;
  if (lastAction < 14) comp5 += 3;
  if (eng.recent_reviews > 0) comp5 += 2;
  if (lastOpen < 30)  comp5 += 2;
  if (lastOpen > 30)  comp5 = Math.max(0, comp5 - 4);

  const score = Math.min(100, comp1 + comp2 + comp3 + comp4 + comp5);

  // Persist score with component breakdown
  await db.query(`
    INSERT INTO tax_health_scores
      (user_id, score, comp_deduction_coverage, comp_set_aside,
       comp_completeness, comp_deadline, comp_engagement, calculated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
  `, [userId, score, comp1, comp2, comp3, comp4, comp5]);

  console.log(`[score] ${userId}: ${score} (C1:${comp1} C2:${comp2} C3:${comp3} C4:${comp4} C5:${comp5})`);
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Push notifications — per spec: specific, gain-framed, max 2/day
// ─────────────────────────────────────────────────────────────────────────────
async function fireDeductionNotifications(userId, events) {
  // Check how many notifications sent today
  const todayRow = await db.query(`
    SELECT COUNT(*) AS count FROM push_notifications
    WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '24 hours'
  `, [userId]);

  const sentToday = parseInt(todayRow.rows[0]?.count || 0);
  if (sentToday >= 2) {
    console.log(`[notify] ${userId}: daily cap reached, skipping`);
    return;
  }

  // Group by type — if multiple deductions, summarize
  if (events.length === 1) {
    const { tx, decision } = events[0];
    const merchantName = tx.merchant_name || tx.name;
    const savings      = `$${decision.deductionAmount.toFixed(2)}`;

    await sendPushNotification(userId, {
      title: `${merchantName} added ${savings} to your savings ✓`,
      body:  `${decision.category} — tap to remove if wrong`,
      type:  "NEW_DEDUCTION",
      data:  { transactionId: tx.transaction_id, amount: tx.amount },
    });
  } else {
    const totalSavings = events.reduce((s, e) => s + e.decision.deductionAmount, 0);
    await sendPushNotification(userId, {
      title: `${events.length} new deductions found`,
      body:  `+$${totalSavings.toFixed(2)} added to your tax savings`,
      type:  "BULK_DEDUCTIONS",
      data:  { count: events.length },
    });
  }
}

async function sendPushNotification(userId, { title, body, type, data = {} }) {
  // Log to DB
  await db.query(
    `INSERT INTO push_notifications (user_id, title, body, type, data, sent_at)
     VALUES ($1,$2,$3,$4,$5, NOW())`,
    [userId, title, body, type, JSON.stringify(data)]
  ).catch(() => {});

  // TODO: replace with your actual push provider
  // Firebase: await admin.messaging().send({ token: userFCMToken, notification: { title, body }, data })
  // Expo:     await fetch("https://exp.host/--/api/v2/push/send", { method:"POST", body: JSON.stringify({...}) })
  console.log(`[notify → ${userId}] "${title}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API routes — called by the React dashboard
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/deductions/summary  — live dashboard numbers
app.get("/api/deductions/summary", requireAuth, async (req, res) => {
  const ytdStart = `${new Date().getFullYear()}-01-01`;
  try {
    const rows = await db.query(`
      SELECT
        deduction_category                                           AS category,
        COUNT(*)                                                     AS count,
        SUM(amount)                                                  AS gross_amount,
        SUM(deduction_amount)                                        AS tax_savings,
        SUM(CASE WHEN user_confirmed = true  THEN deduction_amount ELSE 0 END) AS confirmed_savings,
        SUM(CASE WHEN user_confirmed IS NULL  THEN deduction_amount ELSE 0 END) AS pending_savings
      FROM transactions
      WHERE user_id = $1 AND is_deductible = true AND date >= $2
        AND (user_confirmed = true OR user_confirmed IS NULL)
      GROUP BY deduction_category
      ORDER BY tax_savings DESC
    `, [req.userId, ytdStart]);

    const totalSavings = rows.rows.reduce((s, r) => s + parseFloat(r.tax_savings || 0), 0);

    // Latest score
    const scoreRow = await db.query(
      "SELECT score FROM tax_health_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1",
      [req.userId]
    );

    res.json({
      totalSavings:    parseFloat(totalSavings.toFixed(2)),
      score:           scoreRow.rows[0]?.score || 0,
      categories:      rows.rows,
    });
  } catch (err) {
    console.error("summary error:", err.message);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

// GET /api/deductions/pending  — transactions awaiting user review
app.get("/api/deductions/pending", requireAuth, async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT plaid_transaction_id, merchant_name, name, amount, date,
             deduction_category, deduction_amount, confidence_score,
             classification_signals, limit_flags
      FROM transactions
      WHERE user_id = $1 AND is_deductible = true
        AND user_confirmed IS NULL AND status IN ('pending','ask_user')
      ORDER BY date DESC
      LIMIT 50
    `, [req.userId]);
    res.json({ pending: rows.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to load pending" });
  }
});

// POST /api/deductions/:txId/confirm  — user confirms a deduction
app.post("/api/deductions/:txId/confirm", requireAuth, async (req, res) => {
  try {
    await db.query(`
      UPDATE transactions
      SET user_confirmed = true, status = 'confirmed', updated_at = NOW()
      WHERE plaid_transaction_id = $1 AND user_id = $2
    `, [req.params.txId, req.userId]);

    await updateStreakAndScore(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to confirm" });
  }
});

// POST /api/deductions/:txId/reject  — user rejects a deduction
app.post("/api/deductions/:txId/reject", requireAuth, async (req, res) => {
  try {
    await db.query(`
      UPDATE transactions
      SET user_confirmed = false, deduction_amount = 0, status = 'rejected', updated_at = NOW()
      WHERE plaid_transaction_id = $1 AND user_id = $2
    `, [req.params.txId, req.userId]);

    await recalculateTaxHealthScore(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject" });
  }
});

// POST /api/deductions/manual  — user manually adds a deduction
app.post("/api/deductions/manual", requireAuth, async (req, res) => {
  const { description, amount, category, date } = req.body;
  if (!description || !amount || !category) {
    return res.status(400).json({ error: "description, amount, category required" });
  }
  try {
    const profile  = await getUserProfile(req.userId);
    const { inferEffectiveRate } = require("./classifier");
    const rate     = inferEffectiveRate(profile);
    const savings  = parseFloat((amount * rate).toFixed(2));

    await db.query(`
      INSERT INTO transactions
        (plaid_transaction_id, user_id, item_id, amount, date, name,
         is_deductible, deduction_category, deduction_amount, tax_rate_applied,
         user_confirmed, status, confidence_score, created_at, updated_at)
      VALUES ($1,$2,'manual',$3,$4,$5,true,$6,$7,$8,true,'confirmed',1.0,NOW(),NOW())
    `, [
      `manual_${req.userId}_${Date.now()}`,
      req.userId, amount, date || new Date().toISOString().split("T")[0],
      description, category, savings, rate,
    ]);

    await updateStreakAndScore(req.userId);
    res.json({ success: true, deductionAmount: savings });
  } catch (err) {
    res.status(500).json({ error: "Failed to add manual deduction" });
  }
});

// GET /api/deductions/export  — CSV export (Feature 02 requirement)
app.get("/api/deductions/export", requireAuth, async (req, res) => {
  const ytdStart = `${new Date().getFullYear()}-01-01`;
  try {
    const rows = await db.query(`
      SELECT date, merchant_name, name, amount, deduction_category,
             deduction_amount, confidence_score,
             CASE WHEN user_confirmed = true AND plaid_transaction_id NOT LIKE 'manual%'
                       THEN 'auto_confirmed'
                  WHEN user_confirmed = true THEN 'user_confirmed'
                  WHEN user_confirmed = false THEN 'rejected'
                  ELSE 'pending' END AS confirmation_status
      FROM transactions
      WHERE user_id = $1 AND is_deductible = true AND date >= $2
      ORDER BY date DESC
    `, [req.userId, ytdStart]);

    const header = "Date,Merchant,Description,Amount,Category,Tax Savings,Confidence,Status\n";
    const csv    = header + rows.rows.map((r) =>
      [r.date, r.merchant_name || "", r.name, r.amount, r.deduction_category,
       r.deduction_amount, r.confidence_score, r.confirmation_status].join(",")
    ).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="smarttax-deductions-${new Date().getFullYear()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: "Export failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getUserProfile(userId) {
  const row = await db.query(
    "SELECT * FROM user_profiles WHERE user_id = $1", [userId]
  );
  return row.rows[0] || {};
}

async function getCategoryYTD(userId, category) {
  if (!category) return 0;
  const ytdStart = `${new Date().getFullYear()}-01-01`;
  const row = await db.query(`
    SELECT COALESCE(SUM(deduction_amount), 0) AS total
    FROM transactions
    WHERE user_id = $1 AND deduction_category = $2 AND date >= $3
      AND (user_confirmed = true OR user_confirmed IS NULL)
  `, [userId, category, ytdStart]);
  return parseFloat(row.rows[0]?.total || 0);
}

function calculateEstimatedLiability(profile, confirmedDeductions) {
  const annualIncome   = (profile.freelanceIncome || 3000) * 12;
  const taxableIncome  = Math.max(0, annualIncome - (confirmedDeductions * 4) - 14600);
  const seTax          = annualIncome * 0.1413;
  const incomeTax      = taxableIncome * 0.22; // simplified
  const stateTax       = taxableIncome * 0.05;
  return (seTax + incomeTax + stateTax) / 4; // quarterly
}

function calculateProfileCompleteness(profile) {
  let score = 0;
  if (profile.freelance_types)  score += 3;
  if (profile.filing_status)    score += 2;
  if (profile.state)            score += 2;
  if (profile.freelance_income) score += 2;
  if (profile.plaid_connected)  score += 4;
  if (profile.income_logged)    score += 1;
  if (profile.receipt_uploaded) score += 1;
  return Math.min(15, score);
}

function getNextQuarterlyDeadline() {
  const now      = new Date();
  const year     = now.getFullYear();
  const deadlines = [
    new Date(year, 3, 15),  // April 15
    new Date(year, 5, 15),  // June 15
    new Date(year, 8, 15),  // Sept 15
    new Date(year + 1, 0, 15), // Jan 15 next year
  ];
  return deadlines.find((d) => d > now) || deadlines[3];
}

async function updateStreakAndScore(userId) {
  // Update streak
  await db.query(`
    INSERT INTO user_engagement (user_id, last_deduction_action)
    VALUES ($1, NOW())
    ON CONFLICT (user_id) DO UPDATE SET last_deduction_action = NOW()
  `, [userId]);
  await recalculateTaxHealthScore(userId);
}
// ── Plaid Link routes ─────────────────────────────────────────────────────
app.post("/api/plaid/create-link-token", requireAuth, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: req.userId },
      client_name:   "SmartTax AI",
      products:      ["transactions"],
      country_codes: ["US"],
      language:      "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create-link-token:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SmartTax deduction engine running on :${PORT}`));

module.exports = { runDeductionPipeline, recalculateTaxHealthScore };
