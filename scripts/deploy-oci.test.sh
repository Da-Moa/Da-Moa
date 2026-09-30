#!/usr/bin/env bash
set -euo pipefail

tmp=$(mktemp -d)
tmp=$(cd "$tmp" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
root="$tmp/root"
export TEST_HOME="$tmp/home" PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" TEST_ENV_FILE="$root/shared/.env.production" TEST_MINIO_ENV_FILE="$root/shared/.minio.env" TEST_DB_PATH="$tmp/db"
mkdir -p "$TEST_HOME" "$tmp/bin" "$tmp/db/postgres" "$tmp/db/minio" "$root/shared" "$root/releases/$sha"
touch "$root/shared/minio.license" "$root/releases/$sha/compose.production.yaml"
ln -s "$root/releases/$sha" "$root/current"
printf 'OLD=value\n' > "$root/shared/.env.production"
printf 'OLD_MINIO=value\n' > "$root/shared/.minio.env"

cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
test -s "$TEST_ENV_FILE"
test -s "$TEST_MINIO_ENV_FILE"
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [[ " $* " == *' inspect '* ]] && [[ " $* " == *' --format '* ]]; then
  if [[ " $* " == *' da-moa-minio-1 '* ]]; then
    if [ -f "$TEST_HOME/legacy-minio" ]; then echo /var/lib/docker/volumes/da-moa_minio-data/_data; else echo "$TEST_DB_PATH/minio"; fi
  else
    if [ -f "$TEST_HOME/legacy-db" ]; then echo /var/lib/docker/volumes/da-moa_postgres-data/_data; else echo "$TEST_DB_PATH/postgres"; fi
  fi
fi
if [[ " $* " == *' run '* ]]; then cat > /dev/null; fi
EOF
cat > "$tmp/bin/mountpoint" <<'EOF'
#!/usr/bin/env bash
test "$*" = "-q $TEST_DB_PATH" && test ! -f "$TEST_HOME/unmounted-db"
EOF
cat > "$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *'http://127.0.0.1:3000/api/health'*) test ! -f "$TEST_HOME/fail-health" ;;
  *) exit 1 ;;
esac
EOF
cat > "$tmp/bin/mv" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -Tf ]; then shift; exec /bin/mv -f "$@"; fi
exec /bin/mv "$@"
EOF
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/mv" "$tmp/bin/mountpoint"
sed -e "s|^root=/srv/da-moa$|root=$root|" -e "s|\$HOME|$TEST_HOME|g" -e "s|/db|$TEST_DB_PATH|g" scripts/deploy-oci.sh > "$tmp/deploy.sh"

printf 'NEW=value\n' > "$TEST_HOME/da-moa-$sha.env.production"
printf 'NEW_MINIO=value\n' > "$TEST_HOME/da-moa-$sha.minio.env"
printf 'OLD=value\n' > "$root/shared/.env.production.backup.legacy"
touch "$TEST_HOME/da-moa-$sha.tar.gz"
bash -s -- "$sha" < "$tmp/deploy.sh"
test ! -e "$root/shared/.env.production"
test ! -e "$root/shared/.minio.env"
test ! -e "$root/shared/.env.production.backup.legacy"
test ! -e "$TEST_HOME/da-moa-$sha.env.production"
test ! -e "$TEST_HOME/da-moa-$sha.minio.env"
grep -q 'up -d --force-recreate --no-deps app' "$DOCKER_LOG"
if grep -Eq 'prometheus|grafana|blackbox|node-exporter' "$DOCKER_LOG"; then
  echo 'Application deployment must not manage monitoring services' >&2
  exit 1
fi

printf 'BAD=value\n' > "$TEST_HOME/da-moa-$sha.env.production"
printf 'BAD_MINIO=value\n' > "$TEST_HOME/da-moa-$sha.minio.env"
touch "$TEST_HOME/da-moa-$sha.tar.gz" "$TEST_HOME/fail-health"
if bash -s -- "$sha" < "$tmp/deploy.sh"; then
  echo 'Expected deployment failure' >&2
  exit 1
fi
test ! -e "$root/shared/.env.production"
test ! -e "$root/shared/.minio.env"
test ! -e "$TEST_HOME/da-moa-$sha.env.production"
test ! -e "$TEST_HOME/da-moa-$sha.minio.env"
test "$(grep -c 'up -d --force-recreate --no-deps app' "$DOCKER_LOG")" -eq 2
echo 'Deployment environment cleanup passed'

rm -f "$TEST_HOME/fail-health"
for failure in unmounted-db legacy-db legacy-minio missing-minio; do
  printf 'NEW=value\n' > "$TEST_HOME/da-moa-$sha.env.production"
  printf 'NEW_MINIO=value\n' > "$TEST_HOME/da-moa-$sha.minio.env"
  touch "$TEST_HOME/da-moa-$sha.tar.gz" "$TEST_HOME/$failure"
  if [ "$failure" = missing-minio ]; then rmdir "$TEST_DB_PATH/minio"; fi
  if bash -s -- "$sha" < "$tmp/deploy.sh"; then
    echo "Expected deployment to reject $failure" >&2
    exit 1
  fi
  test ! -e "$root/shared/.env.production"
  test ! -e "$root/shared/.minio.env"
  test "$(grep -c 'up -d --force-recreate --no-deps app' "$DOCKER_LOG")" -eq 2
  test "$(grep -c 'up -d --wait --no-recreate postgres minio' "$DOCKER_LOG")" -eq 2
  rm "$TEST_HOME/$failure"
  mkdir -p "$TEST_DB_PATH/minio"
done
echo 'PostgreSQL and MinIO mount guards passed'
