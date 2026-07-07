#!/usr/bin/env bash
# One-shot interactive setup: writes .env, installs deps, inits the DB,
# and verifies the seed. Run from the repo root:  bash scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

if [ -f .env ]; then
  bold ".env already exists — reusing it. Delete it first to start over."
else
  bold "Paste each value and hit enter (input hidden for secrets)."

  read -r -p "DATABASE_URL (from Render, External Database URL): " DB_URL
  # Render external connections require SSL; append if missing.
  case "$DB_URL" in
    *render.com*sslmode=*) : ;;
    *render.com*) DB_URL="${DB_URL}?sslmode=require" ;;
  esac

  read -r -s -p "ANTHROPIC_API_KEY: " ANTHROPIC; echo
  read -r -s -p "HEVY_API_KEY: " HEVY; echo
  read -r -p "WHOOP_CLIENT_ID: " WHOOP_ID
  read -r -s -p "WHOOP_CLIENT_SECRET: " WHOOP_SECRET; echo

  # Codespaces: derive the public callback URL automatically.
  if [ -n "${CODESPACE_NAME:-}" ]; then
    REDIRECT="https://${CODESPACE_NAME}-3000.app.github.dev/auth/whoop/callback"
    bold "Detected Codespace — WHOOP redirect: $REDIRECT"
  else
    read -r -p "WHOOP_REDIRECT_URI [http://localhost:3000/auth/whoop/callback]: " REDIRECT
    REDIRECT="${REDIRECT:-http://localhost:3000/auth/whoop/callback}"
  fi

  cat > .env <<EOF
DATABASE_URL=$DB_URL
ANTHROPIC_API_KEY=$ANTHROPIC
HEVY_API_KEY=$HEVY
WHOOP_CLIENT_ID=$WHOOP_ID
WHOOP_CLIENT_SECRET=$WHOOP_SECRET
WHOOP_REDIRECT_URI=$REDIRECT
EOF
  bold "Wrote .env"
fi

set -a; . ./.env; set +a

if ! command -v psql >/dev/null; then
  bold "Installing postgresql-client (psql)..."
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client
fi

bold "Installing dependencies..."
npm install --no-fund --no-audit

bold "Creating tables + seeding working weights..."
npm run db:init

bold "Verifying seed:"
psql "$DATABASE_URL" -c "SELECT exercise, weight_lbs, hard_cap_lbs FROM working_weights ORDER BY muscle_group, exercise"
psql "$DATABASE_URL" -c "SELECT phase, week_in_phase, event_date FROM plan_state"

bold "Done. Next:"
echo "  1. npm run dev"
echo "  2. Make port 3000 public: PORTS tab -> right-click 3000 -> Port Visibility -> Public"
echo "  3. Open ${WHOOP_REDIRECT_URI%/auth/whoop/callback} and hit /auth/whoop to connect WHOOP"
