-- ============================================================
-- Fitness Coach schema
-- Derived from FITNESS SPEC v2 (Matt)
-- Rules (two-coach logic, WHOOP tiers, periodization) live in the
-- coach system prompt, NOT here. This DB holds MUTABLE STATE only:
-- working weights, synced history, daily recovery, phase pointer.
-- ============================================================

-- --- WHOOP daily recovery/sleep/strain (synced nightly + on demand) ---
CREATE TABLE IF NOT EXISTS whoop_daily (
  day             DATE PRIMARY KEY,
  recovery_pct    INTEGER,          -- drives GREEN/YELLOW/RED gate
  hrv_ms          NUMERIC,
  resting_hr      INTEGER,
  sleep_hours     NUMERIC,
  strain          NUMERIC,
  raw             JSONB,            -- full payload for later use
  synced_at       TIMESTAMPTZ DEFAULT now()
);

-- --- WHOOP OAuth tokens (single user) ---
CREATE TABLE IF NOT EXISTS whoop_tokens (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- --- Current working weights (the spec's live table) ---
-- "Log history overrides this table once it accumulates." The coach
-- reads this for prescription and updates it via progression rules.
CREATE TABLE IF NOT EXISTS working_weights (
  exercise        TEXT PRIMARY KEY,       -- e.g. 'Barbell Bench Press'
  muscle_group    TEXT,                   -- CHEST/BACK/SHOULDERS/ARMS/LEGS
  weight_lbs      NUMERIC,                -- NULL = calibration pending
  hard_cap_lbs    NUMERIC,                -- e.g. OHP capped at 95 (shoulder)
  is_compound     BOOLEAN DEFAULT false,  -- compounds progress by weight
  is_protected    BOOLEAN DEFAULT false,  -- bench/OHP/curl = favorites
  progression     TEXT DEFAULT 'weight',  -- 'weight' | 'reps'
  note            TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- --- Training history (synced from Hevy + RPE/notes overlay) ---
CREATE TABLE IF NOT EXISTS workout_sessions (
  id              TEXT PRIMARY KEY,       -- Hevy workout id
  day             DATE NOT NULL,
  title           TEXT,                   -- e.g. 'Upper (Strength)'
  slot            TEXT,                   -- MON_UPPER_STR, WED_Z2, etc.
  total_volume    NUMERIC,
  total_sets      INTEGER,
  notes           TEXT,
  raw             JSONB,
  synced_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workout_sets (
  id              SERIAL PRIMARY KEY,
  session_id      TEXT REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise        TEXT NOT NULL,
  set_index       INTEGER,
  weight_lbs      NUMERIC,
  reps            INTEGER,
  rpe             NUMERIC
);

-- --- Cardio / aerobic sessions (Johnston tracking) ---
-- Pace-at-HR over time is THE aerobic progress metric.
CREATE TABLE IF NOT EXISTS cardio_sessions (
  id              SERIAL PRIMARY KEY,
  day             DATE NOT NULL,
  modality        TEXT,                   -- treadmill_hike, walk, pack_hike
  duration_min    INTEGER,
  avg_hr          INTEGER,
  incline_pct     NUMERIC,
  speed_mph       NUMERIC,
  pack_weight_lbs NUMERIC,                -- Specific phase loaded hikes
  is_drift_test   BOOLEAN DEFAULT false,
  note            TEXT
);

-- --- Aerobic threshold ceiling (set/updated by drift test) ---
CREATE TABLE IF NOT EXISTS aet_ceiling (
  id              SERIAL PRIMARY KEY,
  set_on          DATE NOT NULL,
  aet_hr          INTEGER NOT NULL,       -- the Zone 2 ceiling
  test_incline    NUMERIC,
  test_speed      NUMERIC,
  drift_pct      NUMERIC,
  note            TEXT
);

-- --- Phase pointer (where we are in the October countdown) ---
CREATE TABLE IF NOT EXISTS plan_state (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  phase           TEXT NOT NULL,          -- BASE | SPECIFIC | SHARPEN
  week_in_phase   INTEGER DEFAULT 1,
  event_date      DATE NOT NULL,          -- the October hunt
  pack_weight_lbs NUMERIC,                -- current loaded-hike weight
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- --- Coach conversation log (chat + morning check-ins) ---
CREATE TABLE IF NOT EXISTS coach_messages (
  id              SERIAL PRIMARY KEY,
  day             DATE DEFAULT CURRENT_DATE,
  role            TEXT NOT NULL,          -- user | assistant | system
  kind            TEXT,                   -- checkin | chat | plan
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);
