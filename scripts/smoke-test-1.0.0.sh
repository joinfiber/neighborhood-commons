#!/usr/bin/env bash
# Smoke-test the new 1.0.0 public read endpoints.
# Run against any environment by setting BASE.
#
# Usage:
#   BASE=http://localhost:3001 ./scripts/smoke-test-1.0.0.sh
#   BASE=https://api.neighborhood-commons.org ./scripts/smoke-test-1.0.0.sh

set -e

BASE="${BASE:-http://localhost:3001}"
echo "Smoke-testing new 1.0.0 public read endpoints against: $BASE"
echo ""

check() {
  local name="$1"
  local url="$2"
  local expect_keys="$3"  # space-separated list of keys expected at the top level

  echo -n "[$name] $url … "
  local response
  response=$(curl -s -w "\n__HTTP__:%{http_code}" "$url")
  local body status
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1 | sed 's/__HTTP__://')

  if [ "$status" != "200" ]; then
    echo "FAIL ($status)"
    echo "  Response: $body" | head -c 500
    echo ""
    return 1
  fi

  # Verify expected keys exist at top level
  for key in $expect_keys; do
    if ! echo "$body" | grep -q "\"$key\""; then
      echo "FAIL (missing key: $key)"
      echo "  Response: $body" | head -c 500
      echo ""
      return 1
    fi
  done

  local count
  count=$(echo "$body" | grep -oE '"total":[ ]*[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "?")
  echo "OK (total=$count)"
}

# === Places ===
check "places list"       "$BASE/api/v1/places?limit=5"            "meta places"
check "places list filtered" "$BASE/api/v1/places?q=phila&limit=5"   "meta places"

# === Organizations ===
check "orgs list"         "$BASE/api/v1/organizations?limit=5"      "meta organizations"
check "orgs by kind"      "$BASE/api/v1/organizations?kind=local_business&limit=5"  "meta organizations"
check "orgs verified"     "$BASE/api/v1/organizations?verified=true&limit=5"        "meta organizations"

# === Persons ===
check "persons list"      "$BASE/api/v1/persons?limit=5"            "meta persons"

# === Broadcasts ===
check "broadcasts list"   "$BASE/api/v1/broadcasts?limit=5"         "meta broadcasts"

# === Lists ===
check "lists list"        "$BASE/api/v1/lists?limit=5"              "meta lists"

# === Verifiers (reputation graph) ===
check "verifiers list"    "$BASE/api/v1/verifiers"                  "verifiers"

# === Existing endpoints (regression check) ===
echo ""
echo "Regression checks (existing endpoints should still work):"
check "events list"       "$BASE/api/v1/events?limit=5"             "meta events"
check "groups list"       "$BASE/api/v1/groups?limit=5"             "groups"
check "accounts list"     "$BASE/api/v1/accounts?limit=5"           "accounts"

echo ""
echo "All endpoints responded 200. Spec at $BASE/openapi.json."
