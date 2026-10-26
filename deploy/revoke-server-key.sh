#!/usr/bin/env bash
# Revokes ONE server's Firebase access: deletes every key of service account spot-<device>, removes its
# roles, then deletes the account. Its worker loses access once its cached token expires (up to an hour,
# usually minutes) and stops; other servers are untouched and take over its WhatsApp accounts.
#
#   deploy/revoke-server-key.sh <device-name> [--dry-run] [--yes]
set -euo pipefail
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
for _v in $(compgen -v SPOT_ || true); do _n="NBS_${_v#SPOT_}"; [[ -n "${!_n+x}" ]] || export "$_n=${!_v}"; done

PROJECT="${NBS_PROJECT:-spot-solutions}"
BUCKET="${NBS_BUCKET:-spot-solutions.firebasestorage.app}"
PROJECT_ROLES=(roles/datastore.user roles/firebasecloudmessaging.admin)
BUCKET_ROLES=(roles/storage.objectAdmin)

DRY=0; YES=0; DEVICE=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "Unknown option $a" >&2; exit 1 ;;
    *) DEVICE="$a" ;;
  esac
done
[[ -n "$DEVICE" ]] || { echo "usage: $0 <device-name> [--dry-run] [--yes]" >&2; exit 1; }
DEVICE="$(printf '%s' "$DEVICE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
SA_ID="spot-$DEVICE"
SA_EMAIL="$SA_ID@$PROJECT.iam.gserviceaccount.com"

run() { if (( DRY )); then printf '  %q' "$@"; printf '\n'; else "$@"; fi; }

if (( DRY )); then
  echo "DRY RUN: nothing is changed. Commands that would run against project '$PROJECT':"
  echo "  # for every user-managed key id of $SA_EMAIL:"
  run gcloud iam service-accounts keys delete "<KEY_ID>" --iam-account "$SA_EMAIL" --project "$PROJECT" --quiet
else
  command -v gcloud >/dev/null || { echo "gcloud not found." >&2; exit 1; }
  gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 || { echo "No service account $SA_EMAIL in $PROJECT." >&2; exit 1; }
  if (( ! YES )); then
    read -r -p "Revoke $SA_EMAIL (deletes its keys and the account)? Type the device name to confirm: " ans
    [[ "$ans" == "$DEVICE" ]] || { echo "Cancelled."; exit 1; }
  fi
  # Keys first, so access ends even if a later step fails.
  for k in $(gcloud iam service-accounts keys list --iam-account "$SA_EMAIL" --project "$PROJECT" --managed-by=user --format='value(name.basename())'); do
    gcloud iam service-accounts keys delete "$k" --iam-account "$SA_EMAIL" --project "$PROJECT" --quiet
  done
fi

for r in "${BUCKET_ROLES[@]}"; do
  run gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_EMAIL" --role "$r" --quiet --format=none || true
done
for r in "${PROJECT_ROLES[@]}"; do
  run gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role "$r" --condition=None --quiet --format=none || true
done
run gcloud iam service-accounts delete "$SA_EMAIL" --project "$PROJECT" --quiet

(( DRY )) || echo "Revoked $SA_EMAIL. Wipe the device or uninstall Nothing BOT Server there; its key no longer works."
