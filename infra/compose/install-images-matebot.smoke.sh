#!/usr/bin/env bash
# install-images-matebot.sh uses the fork download base and matebot GHCR defaults.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
matebot="$root/install-images-matebot.sh"
upstream="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -x "$matebot" ]] || fail "install-images-matebot.sh is not executable"

grep -q 'Lizer2009/matebot/main/infra/compose' "$matebot" ||
  fail "matebot installer must default RAKAZO_DOWNLOAD_BASE to the fork raw URL"

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

grep -q '^RAKAZO_IMAGE=ghcr.io/lizer2009/matebot/app$' "$tmp/cwd/.env" ||
  fail "matebot .env missing fork app image"
grep -q '^RAKAZO_COMPUTER_IMAGE=ghcr.io/lizer2009/matebot/computer$' "$tmp/cwd/.env" ||
  fail "matebot .env missing fork computer image"

# The upstream installer is exercised against the upstream image defaults. This repository's own
# `.env.images.example` names this product's images now, so the fixture starts from it and puts the
# upstream image lines back: the installer under test here is the upstream one, and the example is
# only a source of the required secrets.
rm -f "$tmp/cwd/.env"
cp "$root/.env.images.example" "$tmp/cwd/.env.images.example"
sed -i.bak \
  -e 's|^RAKAZO_IMAGE=.*|RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app|' \
  -e 's|^RAKAZO_COMPUTER_IMAGE=.*|RAKAZO_COMPUTER_IMAGE=ghcr.io/elie222/rakazo/computer|' \
  "$tmp/cwd/.env.images.example"
rm -f "$tmp/cwd/.env.images.example.bak"
out2="$(
  cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" bash "$upstream" --local --prepare-only 2>&1
)" || fail "upstream prepare-only failed: $out2"
grep -q '^RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app$' "$tmp/cwd/.env" ||
  fail "upstream .env must keep official image defaults"

echo "OK: install-images-matebot defaults"
