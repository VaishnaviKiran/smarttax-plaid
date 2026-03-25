-- ─── SmartTax AI — Full Database Schema ────────────────────────────────────
-- Run this once in your Postgres database
-- Covers: Plaid items, transactions, deductions, scoring, engagement, notifications
-- ─────────────────────────────────────────────────────────────────────────────

-- Plaid connected bank accounts
CREATE TABLE IF NOT EXISTS plaid_items (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  access_token  TEXT NOT NULL,        -- store encrypted at rest
  item_id       TEXT NOT NULL UNIQUE,
  cursor        TEXT,                 -- transactions/sync cursor
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plaid_items_user ON plaid_items (user_id);

-- All transactions (deductible + personal)
CREATE TABLE IF NOT EXISTS transactions (
  plaid_transaction_id  TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  item_id               TEXT NOT NULL,
  account_id            TEXT,
  amount                NUMERIC(12,2) NOT NULL,
  date                  DATE NOT NULL,
  merchant_name         TEXT,
  name                  TEXT,
  payment_channel       TEXT,
  plaid_category_primary    TEXT,
  plaid_category_detailed   TEXT,

  -- Deduction classification
  is_deductible         BOOLEAN DEFAULT false,
  confidence_score      NUMERIC(5,3),
  deduction_category    TEXT,
  schedule_c_line       TEXT,
  deduction_pct         NUMERIC(5,4) DEFAULT 1.0,
  deduction_amount      NUMERIC(12,2) DEFAULT 0,
  tax_rate_applied      NUMERIC(5,4),
  classification_signals JSONB DEFAULT '[]',
  limit_flags           JSONB DEFAULT '[]',

  -- User review
  user_confirmed        BOOLEAN,     -- NULL=pending, TRUE=confirmed, FALSE=rejected
  status                TEXT DEFAULT 'pending',  -- auto_confirmed|pending|ask_user|confirmed|rejected

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date     ON transactions (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_user_pending  ON transactions (user_id, user_confirmed) WHERE is_deductible = true;
CREATE INDEX IF NOT EXISTS idx_tx_user_category ON transactions (user_id, deduction_category);

-- User onboarding profile (drives Tax Health Score + classifier)
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id               TEXT PRIMARY KEY,
  freelance_types       TEXT[],               -- ['developer','designer']
  work_setup            TEXT,                 -- fully_freelance|freelance_w2|just_started
  incorporation_status  TEXT,                 -- sole_prop|llc|s_corp|not_sure
  filing_status         TEXT,                 -- single|married_joint|married_sep|hoh
  state                 TEXT,                 -- 2-letter code
  freelance_income      NUMERIC(10,2),        -- monthly estimate
  w2_income             NUMERIC(10,2),        -- annual
  spouse_income         NUMERIC(10,2),        -- annual
  dependents            INTEGER DEFAULT 0,
  home_office           TEXT,                 -- dedicated|sometimes|none
  home_ownership        TEXT,                 -- rent|own
  car_for_work          TEXT,                 -- regularly|sometimes|no
  health_insurance      BOOLEAN DEFAULT false,
  filed_self_employed   TEXT,                 -- yes|no|not_sure
  made_estimated_payments BOOLEAN DEFAULT false,
  retirement_type       TEXT,                 -- sep_ira|solo_401k|traditional_ira|none
  student_loans         BOOLEAN DEFAULT false,
  tools_selected        TEXT[],
  expected_annual_deductions NUMERIC(12,2),   -- system estimate from profile
  plaid_connected       BOOLEAN DEFAULT false,
  income_logged         BOOLEAN DEFAULT false,
  receipt_uploaded      BOOLEAN DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Tax Health Score history
CREATE TABLE IF NOT EXISTS tax_health_scores (
  id                        SERIAL PRIMARY KEY,
  user_id                   TEXT NOT NULL,
  score                     INTEGER NOT NULL,
  comp_deduction_coverage   INTEGER,
  comp_set_aside            INTEGER,
  comp_completeness         INTEGER,
  comp_deadline             INTEGER,
  comp_engagement           INTEGER,
  score_explanation         TEXT,
  recommended_action        TEXT,
  calculated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scores_user ON tax_health_scores (user_id, calculated_at DESC);

-- Tax set-asides (money user marks as saved for taxes)
CREATE TABLE IF NOT EXISTS tax_set_asides (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  date        DATE NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_setasides_user ON tax_set_asides (user_id, date DESC);

-- Quarterly tax payments logged by user
CREATE TABLE IF NOT EXISTS quarterly_payments (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  payment_date  DATE NOT NULL,
  quarter       TEXT,               -- Q1|Q2|Q3|Q4
  tax_year      INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON quarterly_payments (user_id, payment_date DESC);

-- Push notification log (for daily cap enforcement)
CREATE TABLE IF NOT EXISTS push_notifications (
  id        SERIAL PRIMARY KEY,
  user_id   TEXT NOT NULL,
  title     TEXT,
  body      TEXT,
  type      TEXT,
  data      JSONB DEFAULT '{}',
  sent_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifs_user_date ON push_notifications (user_id, sent_at DESC);

-- Engagement tracking (streak, last actions)
CREATE TABLE IF NOT EXISTS user_engagement (
  user_id                 TEXT PRIMARY KEY,
  last_opened_at          TIMESTAMPTZ,
  last_deduction_action   TIMESTAMPTZ,
  streak_days             INTEGER DEFAULT 0,
  streak_last_date        DATE,
  total_deductions_logged INTEGER DEFAULT 0,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Manual income entries (when not detectable from Plaid)
CREATE TABLE IF NOT EXISTS income_entries (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  source      TEXT,
  date        DATE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_income_user ON income_entries (user_id, date DESC);

-- Freelancer Wrapped monthly snapshots
CREATE TABLE IF NOT EXISTS monthly_wrapped (
  id                  SERIAL PRIMARY KEY,
  user_id             TEXT NOT NULL,
  year                INTEGER NOT NULL,
  month               INTEGER NOT NULL,
  total_deductions    NUMERIC(12,2),
  total_tax_savings   NUMERIC(12,2),
  score_start         INTEGER,
  score_end           INTEGER,
  top_category        TEXT,
  top_category_amount NUMERIC(12,2),
  label               TEXT,        -- "Tax Nerd 🧠" etc
  card_image_url      TEXT,
  generated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, year, month)
);
