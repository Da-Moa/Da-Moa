#!/usr/bin/env bash
set -euo pipefail

tmp=$(mktemp -d)
tmp=$(cd "$tmp" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
root="$tmp/root"
export HOME="$tmp/home" PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" TEST_ENV_FILE="$root/shared/.env.production" TEST_MINIO_ENV_FILE="$root/shared/.minio.env"
mkdir -p "$HOME" "$tmp/bin" "$root/shared" "$root/releases/$sha"
touch "$root/shared/minio.license" "$root/releases/$sha/compose.production.yaml"
ln -s "$root/releases/$sha" "$root/current"
printf 'OLD=value\n' > "$root/shared/.env.production"
printf 'OLD_MINIO=value\n' > "$root/shared/.minio.env"

cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
test -s "$TEST_ENV_FILE"
test -s "$TEST_MINIO_ENV_FILE"
printf '%s\n' "$*" >> "$DOCKER_LOG"
EOF
cat > "$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
test ! -f "$HOME/fail-health"
EOF
cat > "$tmp/bin/mv" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -Tf ]; then shift; exec /bin/mv -f "$@"; fi
exec /bin/mv "$@"
EOF
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/mv"
sed "s|^root=/srv/da-moa$|root=$root|" scripts/deploy-oci.sh > "$tmp/deploy.sh"

printf 'NEW=value\n' > "$HOME/da-moa-$sha.env.production"
printf 'NEW_MINIO=value\n' > "$HOME/da-moa-$sha.minio.env"
printf 'OLD=value\n' > "$root/shared/.env.production.backup.legacy"
touch "$HOME/da-moa-$sha.tar.gz"
bash "$tmp/deploy.sh" "$sha"
test ! -e "$root/shared/.env.production"
test ! -e "$root/shared/.minio.env"
test ! -e "$root/shared/.env.production.backup.legacy"
test ! -e "$HOME/da-moa-$sha.env.production"
test ! -e "$HOME/da-moa-$sha.minio.env"
grep -q 'up -d --force-recreate --no-deps app' "$DOCKER_LOG"

printf 'BAD=value\n' > "$HOME/da-moa-$sha.env.production"
printf 'BAD_MINIO=value\n' > "$HOME/da-moa-$sha.minio.env"
touch "$HOME/da-moa-$sha.tar.gz" "$HOME/fail-health"
if bash "$tmp/deploy.sh" "$sha"; then
  echo 'Expected deployment failure' >&2
  exit 1
fi
test ! -e "$root/shared/.env.production"
test ! -e "$root/shared/.minio.env"
test ! -e "$HOME/da-moa-$sha.env.production"
test ! -e "$HOME/da-moa-$sha.minio.env"
test "$(grep -c 'up -d --force-recreate --no-deps app' "$DOCKER_LOG")" -eq 2
echo 'Deployment environment cleanup passed'
