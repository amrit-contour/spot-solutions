#!/usr/bin/env bash
# Adds the Nothing BOT Curating / Comedy hosting domains to Firebase Auth's authorized sign-in domains.
# The firebase CLI can't do this; the Identity Toolkit admin API can. NOT run automatically: read it, then run it
# yourself while logged in to gcloud as an owner/editor of the project:   bash deploy/authorize-domains.sh
# It only ADDS domains (existing ones are kept), and does nothing if they are already there.
set -euo pipefail
PROJECT="${FIREBASE_PROJECT:-spot-solutions}"
NEW=(
  nothingbotcurating.web.app nothingbotcurating.firebaseapp.com
  nothing-bot-curating.web.app nothing-bot-curating.firebaseapp.com
  nothingbotcomedy.web.app nothingbotcomedy.firebaseapp.com
  nothing-bot-comedy.web.app nothing-bot-comedy.firebaseapp.com
)
TOKEN=$(gcloud auth print-access-token)
API="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config"
HDR=(-H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT" -H "Content-Type: application/json")

CURRENT=$(curl -fsS "${HDR[@]}" "$API" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).authorizedDomains||[])))')
MERGED=$(NEW_DOMAINS="${NEW[*]}" CURRENT="$CURRENT" node -e 'const c=JSON.parse(process.env.CURRENT);const n=process.env.NEW_DOMAINS.split(" ");console.log(JSON.stringify([...new Set([...c,...n])]))')
echo "Before: $CURRENT"
echo "After:  $MERGED"
curl -fsS -X PATCH "${HDR[@]}" "$API?updateMask=authorizedDomains" -d "{\"authorizedDomains\":$MERGED}" >/dev/null
echo "Authorized domains updated for $PROJECT."
