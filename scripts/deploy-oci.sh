#!/usr/bin/env bash
set -euo pipefail

sha="${1:?commit SHA required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }

root=/srv/da-moa
release="$root/releases/$sha"
archive="$HOME/da-moa-$sha.tar.gz"
env_file="$root/shared/.env.production"
test -f "$env_file"
test -f "$root/shared/.minio.env"
test -f "$root/shared/minio.license"
test -f "$archive"
previous=''
if [ -L "$root/current" ]; then previous=$(readlink -f "$root/current"); fi
trap 'rm -f "$archive"' EXIT
if [ "$previous" != "$release" ]; then
  rm -rf "$release"
  mkdir -p "$release"
  tar -xzf "$archive" -C "$release"
  ln -s "$env_file" "$release/.env.production"
  ln -s "$root/shared/.minio.env" "$release/.minio.env"
fi

export APP_VERSION="$sha"
dc() { docker compose -p da-moa --env-file "$env_file" -f "$release/compose.production.yaml" "$@"; }
dc up -d --wait --no-recreate postgres minio
if [ "$previous" != "$release" ]; then
  dc build app
  dc run --rm --no-deps app npm run db:migrate
  dc up -d --no-deps app
  if ! curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-connrefused http://127.0.0.1:3000/api/openapi.json > /dev/null; then
    if [ -n "$previous" ]; then
      APP_VERSION="$(basename "$previous")" docker compose -p da-moa --env-file "$env_file" -f "$previous/compose.production.yaml" up -d --no-deps app
    fi
    echo 'Deployment failed; restored previous app when available' >&2
    exit 1
  fi
  ln -s "$release" "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
fi

echo "Deployed $sha"
