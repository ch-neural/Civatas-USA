#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# Civatas End-to-End Pipeline Test
# Tests: ingestion → synthesis → persona → adapter
# ─────────────────────────────────────────────────────
set -euo pipefail

API="http://localhost:8000"
INGESTION="http://localhost:8001"
SYNTHESIS="http://localhost:8002"
PERSONA="http://localhost:8003"
ADAPTER="http://localhost:8005"

SAMPLE_FILE="${1:-../data/templates/presidential_state_PA.json}"
TARGET_COUNT="${2:-5}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

echo "╔══════════════════════════════════════════╗"
echo "║  Civatas Pipeline E2E Test               ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Parse upload ──────────────
info "Step 1: Ingestion — parsing $SAMPLE_FILE"
CONFIG=$(curl -sf -X POST "$INGESTION/parse" \
  -F "file=@$SAMPLE_FILE;filename=$(basename $SAMPLE_FILE)")

if [ -z "$CONFIG" ]; then
  fail "Ingestion: no response"
fi

# Override target_count for test
CONFIG=$(echo "$CONFIG" | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['target_count'] = $TARGET_COUNT
print(json.dumps(d))
")

DIM_COUNT=$(echo "$CONFIG" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['dimensions']))")
pass "Ingestion OK — parsed $DIM_COUNT dimensions"

# ── Step 2: Synthesize ────────────────
info "Step 2: Synthesis — generating $TARGET_COUNT persons"
PERSONS=$(curl -sf -X POST "$SYNTHESIS/generate" \
  -H 'Content-Type: application/json' \
  -d "$CONFIG")

PERSON_COUNT=$(echo "$PERSONS" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])")
if [ "$PERSON_COUNT" != "$TARGET_COUNT" ]; then
  fail "Synthesis: expected $TARGET_COUNT persons, got $PERSON_COUNT"
fi

# Show a sample person
echo "$PERSONS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = d['persons'][0]
fields = ', '.join(f'{k}={v}' for k,v in p.items() if v and k not in ('custom_fields','person_id'))
print(f'  Sample: #{p[\"person_id\"]}: {fields}')
"
pass "Synthesis OK — $PERSON_COUNT persons generated"

# ── Step 3: Persona ───────────────────
info "Step 3: Persona — generating template personas"
PERSONA_REQ=$(echo "$PERSONS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
req = {'persons': d['persons'], 'strategy': 'template', 'locale': 'zh-TW'}
print(json.dumps(req))
")

AGENTS=$(curl -sf -X POST "$PERSONA/generate" \
  -H 'Content-Type: application/json' \
  -d "$PERSONA_REQ")

AGENT_COUNT=$(echo "$AGENTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])")
if [ "$AGENT_COUNT" != "$TARGET_COUNT" ]; then
  fail "Persona: expected $TARGET_COUNT agents, got $AGENT_COUNT"
fi

# Show sample persona
echo "$AGENTS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d['agents'][0]
print(f'  Sample: {a[\"username\"]}: {a[\"user_char\"]}')
"

# Check for ugly empty-field artifacts
UGLY=$(echo "$AGENTS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ugly = sum(1 for a in d['agents'] if '，，' in a.get('user_char','') or ', , ' in a.get('user_char',''))
print(ugly)
")
if [ "$UGLY" != "0" ]; then
  fail "Persona: $UGLY agents have empty-field artifacts (，，)"
fi
pass "Persona OK — $AGENT_COUNT agents, no empty-field artifacts"

# ── Step 4: Export ────────────────────
info "Step 4: Adapter — exporting Twitter CSV"
EXPORT_REQ=$(echo "$AGENTS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
req = {'agents': d['agents'], 'edges': [], 'format': 'twitter_csv'}
print(json.dumps(req))
")

CSV=$(curl -sf -X POST "$ADAPTER/export" \
  -H 'Content-Type: application/json' \
  -d "$EXPORT_REQ")

CSV_LINES=$(echo "$CSV" | wc -l | tr -d ' ')
EXPECTED_LINES=$((TARGET_COUNT + 1))  # header + data rows
if [ "$CSV_LINES" -lt "$EXPECTED_LINES" ]; then
  fail "Adapter: expected $EXPECTED_LINES CSV lines, got $CSV_LINES"
fi

# Verify CSV columns
HEADER=$(echo "$CSV" | head -1)
for col in name username user_char description following_agentid_list previous_tweets; do
  if ! echo "$HEADER" | grep -q "$col"; then
    fail "Adapter: missing column '$col' in CSV header"
  fi
done

pass "Adapter OK — valid CSV with $CSV_LINES lines"

# ── Summary ───────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ All pipeline steps passed!            ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "CSV Preview (first 3 rows):"
echo "$CSV" | head -4
