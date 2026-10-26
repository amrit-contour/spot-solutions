#!/usr/bin/env bash
# Creates a Firebase key for ONE server (Mac, Windows, Ubuntu, VM), run by the admin on a machine where
# gcloud is logged in. Every device gets its own key, so a lost or stolen device is revoked on its own
# (deploy/revoke-server-key.sh) without touching the others.
#
#   deploy/new-server-key.sh <device-name> [--dry-run]
#   e.g.  deploy/new-server-key.sh studio-mac
#
# Makes service account spot-<device> with only what the worker needs:
#   roles/datastore.user                      Firestore read/write (project)
#   roles/storage.objectAdmin                 Cloud Storage objects, on the default bucket only
#   roles/firebasecloudmessaging.admin        send push notifications (FCM)
# No Firebase Auth role: the worker never calls Auth admin APIs (apps/worker/src/firebase.ts only starts
# the Admin SDK; Firestore, Storage and Messaging are the only services used).
#
# --dry-run prints the gcloud commands and creates nothing. The key lands in ${SPOT_KEY_DIR:-$HOME/.spot-keys}.
set -euo pipefail

PROJECT="${SPOT_PROJECT:-spot-solutions}"
BUCKET="${SPOT_BUCKET:-spot-solutions.firebasestorage.app}"
KEY_DIR="${SPOT_KEY_DIR:-$HOME/.spot-keys}"
PROJECT_ROLES=(roles/datastore.user roles/firebasecloudmessaging.admin)
BUCKET_ROLES=(roles/storage.objectAdmin)

DRY=0; DEVICE=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "Unknown option $a" >&2; exit 1 ;;
    *) DEVICE="$a" ;;
  esac
done
[[ -n "$DEVICE" ]] || { echo "usage: $0 <device-name> [--dry-run]" >&2; exit 1; }
DEVICE="$(printf '%s' "$DEVICE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
SA_ID="spot-$DEVICE"
# Service account ids are 6-30 characters, lowercase letters, digits and dashes.
(( ${#SA_ID} >= 6 && ${#SA_ID} <= 30 )) || { echo "Device name makes '$SA_ID' (${#SA_ID} chars); it must be 6-30. Use a shorter name." >&2; exit 1; }
SA_EMAIL="$SA_ID@$PROJECT.iam.gserviceaccount.com"
KEY_FILE="$KEY_DIR/$SA_ID.json"

run() { if (( DRY )); then printf '  %q' "$@"; printf '\n'; else "$@"; fi; }

(( DRY )) && echo "DRY RUN: nothing is created. Commands that would run against project '$PROJECT':"
(( DRY )) || command -v gcloud >/dev/null || { echo "gcloud not found." >&2; exit 1; }

# Does the account exist already? (Re-running only adds another key.)
EXISTS=0
if (( ! DRY )) && gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then EXISTS=1; fi

if (( ! EXISTS )); then
  run gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" \
    --display-name "Spot server: $DEVICE" --description "Worker key for device '$DEVICE'. Revoke with deploy/revoke-server-key.sh."
else
  echo "Service account $SA_EMAIL already exists; adding a fresh key."
fi

for r in "${PROJECT_ROLES[@]}"; do
  run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role "$r" --condition=None --quiet --format=none
done
# Bucket-level, not project-wide: this device cannot touch any other bucket.
for r in "${BUCKET_ROLES[@]}"; do
  run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_EMAIL" --role "$r" --quiet --format=none
done

if (( DRY )); then
  echo "  mkdir -p $KEY_DIR   (mode 700)"
else
  mkdir -p "$KEY_DIR"; chmod 700 "$KEY_DIR"
fi
umask 077
run gcloud iam service-accounts keys create "$KEY_FILE" --iam-account "$SA_EMAIL" --project "$PROJECT"

cat <<MSG

$( (( DRY )) && echo "Would create" || echo "Created" ) key for "$DEVICE":
  account  $SA_EMAIL
  file     $KEY_FILE

Put it on the server:
  1. Open the Server Console on that device (Mac: inside the Nothing BOT Server app; Windows: the "Nothing BOT Server Console"
     shortcut; Ubuntu: sudo spot-console-url).
  2. Drop $SA_ID.json onto "Drop your service-account .json here". The worker restarts by itself.
  3. Delete the file from this machine once it's uploaded (it is a password).
Lost or retired device:  deploy/revoke-server-key.sh $DEVICE
MSG
