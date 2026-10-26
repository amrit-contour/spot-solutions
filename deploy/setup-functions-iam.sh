#!/usr/bin/env bash
# One-time setup for the Cloud Functions behind "Add a server" (join codes) and "Remove server". Run it once,
# as a project Owner, on a machine where gcloud is signed in, BEFORE the first `firebase deploy --only functions`.
#
#   deploy/setup-functions-iam.sh [--dry-run] [--unrestricted]
#
# Makes service account spot-enroller, the functions' own identity (not the default compute account), and gives it:
#   roles/iam.serviceAccountAdmin             create and delete the spot-<device> accounts
#   roles/iam.serviceAccountKeyAdmin          create and delete their keys
#   roles/resourcemanager.projectIamAdmin     grant and remove their project roles, ONLY datastore.user and
#                                             firebasecloudmessaging.admin (an IAM condition; --unrestricted drops it)
#   roles/storage.admin                       on the default bucket only: grant and remove objectAdmin there
#   roles/datastore.user                      read and write join codes and server records in Firestore
#   roles/logging.logWriter                   write function logs
#   roles/eventarc.eventReceiver              receive the Firestore trigger that queues Google Contacts saves
#   roles/cloudtasks.enqueuer                 schedule the one-off task that writes a batch of Google Contacts
# It also lets you (the signed-in account) deploy functions that run as spot-enroller.
#
# Safe to run again: it only adds what is missing. --dry-run prints the gcloud commands and changes nothing.
# Counterpart of deploy/new-server-key.sh and revoke-server-key.sh, which this replaces for day-to-day use.
set -euo pipefail

PROJECT="${SPOT_PROJECT:-spot-solutions}"
BUCKET="${SPOT_BUCKET:-spot-solutions.firebasestorage.app}"
SA_ID="spot-enroller"
SA_EMAIL="$SA_ID@$PROJECT.iam.gserviceaccount.com"
# The roles the functions may hand to a server's account: exactly the ones in new-server-key.sh.
GRANTABLE="'roles/datastore.user', 'roles/firebasecloudmessaging.admin'"
PLAIN_ROLES=(roles/iam.serviceAccountAdmin roles/iam.serviceAccountKeyAdmin roles/datastore.user roles/logging.logWriter roles/eventarc.eventReceiver roles/cloudtasks.enqueuer)
APIS=(iam.googleapis.com cloudresourcemanager.googleapis.com cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com eventarc.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com people.googleapis.com)

DRY=0; UNRESTRICTED=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --unrestricted) UNRESTRICTED=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option $a" >&2; exit 1 ;;
  esac
done

run() { if (( DRY )); then printf '  %q' "$@"; printf '\n'; else "$@"; fi; }

(( DRY )) && echo "DRY RUN: nothing is changed. Commands that would run against project '$PROJECT':"
(( DRY )) || command -v gcloud >/dev/null || { echo "gcloud not found." >&2; exit 1; }

ME=""
if (( ! DRY )); then ME="$(gcloud config get-value account 2>/dev/null || true)"; fi
[[ -n "$ME" || $DRY == 1 ]] || { echo "Sign in first: gcloud auth login" >&2; exit 1; }

echo "1. APIs"
run gcloud services enable "${APIS[@]}" --project "$PROJECT"

echo "2. Service account $SA_EMAIL"
if (( ! DRY )) && gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  already exists"
else
  run gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" \
    --display-name "Spot enroller" --description "Runtime identity of the Nothing BOT Server Cloud Functions (join codes, server removal)."
fi

echo "3. Project roles"
for r in "${PLAIN_ROLES[@]}"; do
  run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role "$r" --condition=None --quiet --format=none
done
if (( UNRESTRICTED )); then
  echo "  projectIamAdmin WITHOUT a condition: the functions could grant any role. Prefer the default."
  run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role roles/resourcemanager.projectIamAdmin --condition=None --quiet --format=none
else
  COND="$(mktemp)"; trap 'rm -f "$COND"' EXIT
  cat > "$COND" <<YAML
title: Only the worker roles
description: The enroller may only grant or remove the roles a Spot server's account needs.
expression: api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([$GRANTABLE])
YAML
  (( DRY )) && { echo "  # condition file:"; sed 's/^/  #   /' "$COND"; }
  run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role roles/resourcemanager.projectIamAdmin --condition-from-file "$COND" --quiet --format=none
fi

echo "4. Bucket role (default bucket only)"
# Some gcloud installs crash on `gcloud storage` (Python ssl). Fall back to the Storage JSON API.
bucket_bind_rest() {
  local token policy
  token="$(gcloud auth print-access-token)"
  policy="$(curl -fsS -H "Authorization: Bearer $token" "https://storage.googleapis.com/storage/v1/b/$BUCKET/iam?optionsRequestedPolicyVersion=3")"
  printf '%s' "$policy" | python3 -c '
import json, sys
p = json.load(sys.stdin); member, role = sys.argv[1], sys.argv[2]
b = next((x for x in p.setdefault("bindings", []) if x["role"] == role and "condition" not in x), None)
if b is None: p["bindings"].append({"role": role, "members": [member]})
elif member not in b["members"]: b["members"].append(member)
print(json.dumps(p))' "serviceAccount:$SA_EMAIL" roles/storage.admin |
    curl -fsS -X PUT -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data @- "https://storage.googleapis.com/storage/v1/b/$BUCKET/iam" >/dev/null
  echo "  bound through the Storage API"
}
if (( DRY )); then
  run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_EMAIL" --role roles/storage.admin --quiet --format=none
  echo "  (fallback) the same binding through the Storage JSON API: GET then PUT https://storage.googleapis.com/storage/v1/b/$BUCKET/iam"
elif ! gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_EMAIL" --role roles/storage.admin --quiet --format=none 2>/dev/null; then
  echo "  gcloud couldn't update the bucket; using the Storage API instead"
  bucket_bind_rest
fi

echo "5. Let you deploy functions that run as $SA_ID"
if [[ "$ME" == *.gserviceaccount.com ]]; then MEMBER="serviceAccount:$ME"; else MEMBER="user:${ME:-<you>}"; fi
run gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" --member "$MEMBER" --role roles/iam.serviceAccountUser --quiet --format=none
# Google Contacts tasks are signed as spot-enroller itself, so it may act as itself (and nothing else).
run gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role roles/iam.serviceAccountUser --quiet --format=none

cat <<MSG

$( (( DRY )) && echo "Would be ready." || echo "Ready." ) Next:
  firebase deploy --only functions
  firebase deploy --only firestore:rules,hosting     (after: pnpm --filter @spot/web build && bash deploy/build-dist.sh)
Then, in the app: Account, Server, Add a server.
MSG
