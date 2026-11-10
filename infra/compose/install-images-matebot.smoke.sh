#!/usr/bin/env bash
# install-images-matebot.sh uses the fork download base and matebot GHCR defaults.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
matebot="$root/install-images-matebot.sh"
shared="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -x "$matebot" ]] || fail "install-images-matebot.sh is not executable"

grep -q 'Lizer2009/matebot/main/infra/compose' "$matebot" ||
  fail "matebot installer must default MATEBOT_DOWNLOAD_BASE to the fork raw URL"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-matebot.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/cwd"
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  if [[ "$a" == config ]]; then
    cat >/dev/null
    grep -E '^[A-Z_]+=' .env
    exit 0
  fi
done
exit 0
STUB
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/curl"
chmod +x "$tmp/bin/docker" "$tmp/bin/curl"
cp "$root/docker-compose.images.yml" "$root/.env.images.matebot.example" "$tmp/cwd/"

out="$(
  cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" bash "$matebot" --local --prepare-only 2>&1
)" || fail "matebot prepare-only failed: $out"

grep -q '^MATEBOT_IMAGE=ghcr.io/lizer2009/matebot/app$' "$tmp/cwd/.env" ||
  fail "matebot .env missing fork app image"
grep -q '^MATEBOT_COMPUTER_IMAGE=ghcr.io/lizer2009/matebot/computer$' "$tmp/cwd/.env" ||
  fail "matebot .env missing fork computer image"

# Both installers are exercised, and each keeps the image defaults from its own env example. The
# shared installer is run against a mirror's image names so the test proves an operator override
# survives, not that a particular registry is baked in.
rm -f "$tmp/cwd/.env"
cp "$root/.env.images.example" "$tmp/cwd/.env.images.example"
sed -i.bak \
  -e 's|^MATEBOT_IMAGE=.*|MATEBOT_IMAGE=registry.example.test/mine/app|' \
  -e 's|^MATEBOT_COMPUTER_IMAGE=.*|MATEBOT_COMPUTER_IMAGE=registry.example.test/mine/computer|' \
  "$tmp/cwd/.env.images.example"
rm -f "$tmp/cwd/.env.images.example.bak"
out2="$(
  cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" bash "$shared" --local --prepare-only 2>&1
)" || fail "shared installer prepare-only failed: $out2"
grep -q '^MATEBOT_IMAGE=registry.example.test/mine/app$' "$tmp/cwd/.env" ||
  fail "shared installer .env must keep the configured image override"

echo "OK: install-images-matebot defaults"
