#!/usr/bin/env bash
# One-time (and safe to re-run) cost controls for the Firebase project:
#   1. Firestore TTL policies on the `expireAt` field, so short-lived documents delete themselves.
#   2. Cloud Storage soft delete OFF on the default bucket, so superseded login objects aren't billed for 7 more days.
#
#   deploy/setup-cost-controls.sh [--dry-run] [extra-collection-group ...]
#
# Collection groups get the policy by NAME, so `commands` covers users/{uid}/commands and servers/{id}/commands.
# Extra groups (for example joinCodes, once it writes expireAt) can be passed as arguments.
#
# Order: run this first, then the one-time backfill of documents that already exist (they have no expireAt):
#   pnpm --filter @spot/worker exec tsx --env-file=.env scripts/backfill-expire-at.ts           (dry run)
#   pnpm --filter @spot/worker exec tsx --env-file=.env scripts/backfill-expire-at.ts --apply
# TTL policies take a while to activate (check the Firestore console); deletion runs within about 24 h of expiry.
#
# Soft delete: `gcloud storage buckets update gs://BUCKET --clear-soft-delete` is tried first. If your gcloud fails
# (some versions hit an SSL error), the script falls back to the REST call it stands for:
#   curl -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
#     -d '{"softDeletePolicy":{"retentionDurationSeconds":"0"}}' https://storage.googleapis.com/storage/v1/b/BUCKET
set -euo pipefail
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
for _v in $(compgen -v SPOT_ || true); do _n="NBS_${_v#SPOT_}"; [[ -n "${!_n+x}" ]] || export "$_n=${!_v}"; done

PROJECT="${NBS_PROJECT:-spot-solutions}"
BUCKET="${NBS_BUCKET:-spot-solutions.firebasestorage.app}"
GROUPS_TTL=(commands notices contactsImport invites)

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "Unknown option $a" >&2; exit 1 ;;
    *) GROUPS_TTL+=("$a") ;;
  esac
done

run() { if (( DRY )); then printf '  %q' "$@"; printf '\n'; else "$@"; fi; }

echo "== Firestore TTL on expireAt ($PROJECT)"
for g in "${GROUPS_TTL[@]}"; do
  run gcloud firestore fields ttls update expireAt --collection-group="$g" --enable-ttl --project "$PROJECT" --quiet
done

echo "== Cloud Storage soft delete off (gs://$BUCKET)"
if (( DRY )); then
  printf '  gcloud storage buckets update gs://%s --clear-soft-delete --project %s\n' "$BUCKET" "$PROJECT"
  printf '  (fallback) curl -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" -d %q https://storage.googleapis.com/storage/v1/b/%s\n' '{"softDeletePolicy":{"retentionDurationSeconds":"0"}}' "$BUCKET"
elif ! gcloud storage buckets update "gs://$BUCKET" --clear-soft-delete --project "$PROJECT"; then
  echo "gcloud could not update the bucket; using the REST API instead" >&2
  curl -fsS -X PATCH \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    -d '{"softDeletePolicy":{"retentionDurationSeconds":"0"}}' \
    "https://storage.googleapis.com/storage/v1/b/$BUCKET" >/dev/null
fi

echo "Done. Next: backfill existing documents (apps/worker/scripts/backfill-expire-at.ts)."
