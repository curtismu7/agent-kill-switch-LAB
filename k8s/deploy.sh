#!/usr/bin/env bash
# Render and (owner-approved only) apply the hosted mock build to the SE cluster.
#
#   NAMESPACE=<dns-label> IMAGE=<ref:tag or ref@sha256:digest> SE_HOST=<plain.host> k8s/deploy.sh --dry-run
#   NAMESPACE=... IMAGE=... SE_HOST=... OWNER_APPROVED=1 k8s/deploy.sh
#
# Rules (owner convention): the manifests use ONLY the literal tokens __IMAGE__ and __SE_HOST__; NAMESPACE has no default (the
# namespace is an owner decision); IMAGE needs an explicit tag or digest (never latest); SE_HOST is a plain host; each value is
# validated before it is rendered with sed (delimiter |); the render is refused if any __TOKEN__ is left in it. --dry-run prints
# the rendered manifests and applies nothing. Apply needs OWNER_APPROVED=1 and is the only path that calls kubectl.
# Exit codes: 0 ok, 1 a token was left unreplaced (refused), 2 bad input, 3 apply not approved, 4 kubectl failed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: deploy.sh [--dry-run]" >&2; exit 2 ;;
esac

die() { echo "deploy.sh: $1" >&2; exit "${2:-2}"; }

NAMESPACE="${NAMESPACE:-}"
IMAGE="${IMAGE:-}"
SE_HOST="${SE_HOST:-}"
[ -n "$NAMESPACE" ] || die "NAMESPACE is required (no default: the namespace is an owner decision)"
[ -n "$IMAGE" ] || die "IMAGE is required (an explicit tag or digest)"
[ -n "$SE_HOST" ] || die "SE_HOST is required (the plain public host)"

# DNS label for the namespace.
[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "NAMESPACE must be a DNS label (lowercase letters, digits, hyphens)"

# IMAGE: a plain reference with an explicit digest, or a tag that is not latest. No shell or sed metacharacters.
if [[ "$IMAGE" =~ ^[A-Za-z0-9./:-]+@sha256:[a-f0-9]{64}$ ]]; then
  :
elif [[ "$IMAGE" =~ ^[A-Za-z0-9./:-]+:[A-Za-z0-9._-]+$ ]]; then
  TAG="${IMAGE##*:}"
  [ "$TAG" != "latest" ] || die "IMAGE must not use the latest tag: give an explicit tag or a digest"
else
  die "IMAGE must be <ref>:<explicit tag> or <ref>@sha256:<digest>, with only letters, digits and . / : @ - characters"
fi

# SE_HOST: one plain DNS host (no scheme, port, path, IP literal or localhost).
[[ "$SE_HOST" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "SE_HOST must be one plain lowercase DNS host (for example ai-demo.example.com)"
[ "${#SE_HOST}" -le 253 ] || die "SE_HOST is too long"
[ "$SE_HOST" != "localhost" ] || die "SE_HOST must not be localhost"
[[ ! "$SE_HOST" =~ ^[0-9.]+$ ]] || die "SE_HOST must be a host name, not an IP address"

OUT="$(mktemp "${TMPDIR:-/tmp}/agent-kill-switch-manifests.XXXXXX")"
trap 'rm -f "$OUT"' EXIT

{
  sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" "$DIR/deployment.yaml"
  echo '---'
  sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" "$DIR/service.yaml"
  echo '---'
  sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" "$DIR/ingress.yaml"
} > "$OUT"

# Refuse a render that still has a placeholder token (a new token in a manifest, or a missing value).
if LEFT="$(grep -nE '__[A-Za-z0-9_]+__|\$\{' "$OUT")"; then
  echo "$LEFT" >&2
  die "refusing: a __TOKEN__ (or \${...}) is left unreplaced in the rendered manifests" 1
fi

if [ "$DRY_RUN" = "1" ]; then
  cat "$OUT"
  echo "deploy.sh: dry run: rendered for namespace $NAMESPACE, image $IMAGE, host $SE_HOST. Nothing applied." >&2
  exit 0
fi

[ "${OWNER_APPROVED:-}" = "1" ] || die "apply is owner-approved only: set OWNER_APPROVED=1 after the owner has approved the first deploy" 3
command -v kubectl >/dev/null 2>&1 || die "kubectl is not installed" 4
kubectl -n "$NAMESPACE" apply -f "$OUT" || die "kubectl apply failed" 4
echo "deploy.sh: applied to namespace $NAMESPACE. Verify by content (the page and the pod imageID), not by a 200." >&2
