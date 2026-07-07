-- Seed from FITNESS SPEC v2, updated after 06/07/2026 session.
-- Working weights = actual session weights, NOT 1RMs.

INSERT INTO plan_state (id, phase, week_in_phase, event_date, pack_weight_lbs)
VALUES (1, 'BASE', 1, '2026-10-01', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO working_weights
  (exercise, muscle_group, weight_lbs, hard_cap_lbs, is_compound, is_protected, progression, note)
VALUES
  ('Barbell Bench Press',    'CHEST',     135, NULL, true,  true,  'weight', 'push 140 next exposure'),
  ('Dumbbell Bench Press',   'CHEST',      85, NULL, false, false, 'weight', NULL),
  ('Incline Barbell Press',  'CHEST',    NULL, NULL, false, false, 'weight', 'calibration pending'),
  ('Incline Dumbbell Press', 'CHEST',      80, NULL, false, false, 'reps',   'RPE hit 9.5 — hold, build reps'),
  ('Conventional Deadlift',  'BACK',      275, NULL, true,  false, 'weight', NULL),
  ('Barbell Bent Over Row',  'BACK',      125, NULL, true,  false, 'weight', 'push 135 next'),
  ('Lat Pulldown',           'BACK',      100, NULL, false, false, 'reps',   'cable variant baseline'),
  ('Barbell OHP',            'SHOULDERS',  85,   95, true,  true,  'weight', 'HARD CAP 95 — shoulder ER limit, rebuild at 85'),
  ('Lateral Raise',          'SHOULDERS',  30, NULL, false, false, 'reps',   'hold, build reps'),
  ('Barbell Curl',           'ARMS',       60, NULL, false, true,  'weight', 'favorite — protect'),
  ('Tricep Pushdown',        'ARMS',       90, NULL, false, false, 'reps',   'hold, build reps'),
  ('Back Squat',             'LEGS',      255, NULL, true,  false, 'weight', 'calibration — first standard-gym squat pending'),
  ('Romanian Deadlift',      'LEGS',       95, NULL, false, false, 'weight', NULL),
  ('Leg Curl',               'LEGS',     NULL, NULL, false, false, 'reps',   'calibration pending'),
  ('Bulgarian Split Squat',  'LEGS',     NULL, NULL, false, false, 'reps',   'calibration pending — terrain bias')
ON CONFLICT (exercise) DO NOTHING;
