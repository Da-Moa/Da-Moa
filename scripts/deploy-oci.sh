#!/usr/bin/env bash
set -euo pipefail

sha="${1:?commit SHA required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }

root=/srv/da-moa
release="$root/releases/$sha"
archive="$HOME/da-moa-$sha.tar.gz"
incoming_env="$HOME/da-moa-$sha.env.production"
incoming_minio_env="$HOME/da-moa-$sha.minio.env"
env_file="$root/shared/.env.production"
minio_env_file="$root/shared/.minio.env"
cleanup() {
  local status=$?
  trap - EXIT
  rm -f "$archive" "$incoming_env" "$incoming_minio_env" "$env_file" "$env_file.next" "$minio_env_file" "$minio_env_file.next" "$root/shared"/.env.production.backup.*
  exit "$status"
}
trap cleanup EXIT
test -f "$root/shared/minio.license"
test -f "$archive"
test -s "$incoming_env"
test -s "$incoming_minio_env"
previous=''
if [ -L "$root/current" ]; then previous=$(readlink -f "$root/current"); fi
install -m 600 "$incoming_env" "$env_file.next"
mv -Tf "$env_file.next" "$env_file"
install -m 600 "$incoming_minio_env" "$minio_env_file.next"
mv -Tf "$minio_env_file.next" "$minio_env_file"
if [ "$previous" != "$release" ]; then
  rm -rf "$release"
  mkdir -p "$release"
  tar -xzf "$archive" -C "$release"
  ln -s "$env_file" "$release/.env.production"
  ln -s "$minio_env_file" "$release/.minio.env"
fi

export APP_VERSION="$sha"
dc() { docker compose -p da-moa --env-file "$env_file" -f "$release/compose.production.yaml" "$@"; }
mountpoint -q /db && test -d /db/postgres && test -d /db/minio || { echo '/db must be mounted and /db/postgres and /db/minio prepared' >&2; exit 1; }
if docker container inspect da-moa-postgres-1 > /dev/null 2>&1; then
  data_source=$(docker inspect da-moa-postgres-1 --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')
  [ "$data_source" = /db/postgres ] || { echo 'Migrate the existing PostgreSQL data to /db/postgres before deploying' >&2; exit 1; }
fi
if docker container inspect da-moa-minio-1 > /dev/null 2>&1; then
  data_source=$(docker inspect da-moa-minio-1 --format '{{range .Mounts}}{{if eq .Destination "/mnt/data"}}{{.Source}}{{end}}{{end}}')
  [ "$data_source" = /db/minio ] || { echo 'Migrate the existing MinIO data to /db/minio before deploying' >&2; exit 1; }
fi
dc up -d --wait --no-recreate postgres minio
dc up -d --wait prometheus grafana
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-max-time 60 --retry-all-errors --max-time 3 --output /dev/null http://127.0.0.1:9090/-/ready
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-max-time 60 --retry-all-errors --max-time 3 --output /dev/null http://127.0.0.1:3001/api/health
if [ "$previous" != "$release" ]; then
  dc build app
fi
dc run --rm --no-deps --interactive=false -T app npm run db:migrate < /dev/null
app_up=(up -d --no-deps app)
if [ "$previous" = "$release" ]; then app_up=(up -d --force-recreate --no-deps app); fi
if ! dc "${app_up[@]}" || ! curl --fail --silent --show-error --retry 60 --retry-delay 2 --retry-max-time 120 --retry-all-errors --max-time 5 --output /dev/null http://127.0.0.1:3000/api/health; then
  if [ -n "$previous" ] && [ "$previous" != "$release" ]; then
    APP_VERSION="$(basename "$previous")" docker compose -p da-moa --env-file "$env_file" -f "$previous/compose.production.yaml" up -d --force-recreate --no-deps app
  fi
  echo 'Deployment failed; previous app code restored when available (using the new environment)' >&2
  exit 1
fi
if [ "$previous" != "$release" ]; then
  ln -s "$release" "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
fi

echo "Deployed $sha"
