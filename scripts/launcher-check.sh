#!/usr/bin/env bash
set -euo pipefail
# Isolated fake EXEs only: this script never starts QQ or a model.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d /tmp/launcher-check-XXXXXX)"
trap 'rm -rf "$T"' EXIT
CSC=/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
if [ ! -f "$CSC" ]; then CSC=/c/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe; fi
if [ ! -f "$CSC" ]; then echo 'Windows .NET Framework compiler not found' >&2; exit 2; fi
cat > "$T/marker.cs" <<'CS'
using System.IO;
class M { static void Main() { File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(), "marker.txt"), "fake process only"); } }
CS
MSYS_NO_PATHCONV=1 "$CSC" /nologo /target:winexe /out:"$(cygpath -w "$T/marker.exe")" "$(cygpath -w "$T/marker.cs")"

make_package() {
  local root="$1" version="$2" kind="$3" folder
  if [ "$kind" = secure ]; then folder="$root/artifacts/mcp-secure-remote/packaged/win-unpacked";
  else folder="$root/release-v$version/win-unpacked"; fi
  mkdir -p "$folder/resources/napcat-runtime"
  cp "$T/marker.exe" "$folder/QQ AI Bot.exe"
  printf 'fake ASAR for %s\n' "$version" > "$folder/resources/app.asar"
  printf 'offline fake package\n' > "$folder/resources/THIRD-PARTY-NOTICES.md"
  local exe_hash asar_hash
  exe_hash="$(sha256sum "$folder/QQ AI Bot.exe" | cut -d ' ' -f 1)"
  asar_hash="$(sha256sum "$folder/resources/app.asar" | cut -d ' ' -f 1)"
  printf '{"schemaVersion":1,"app":"qq-ai-bot","version":"%s","exeSha256":"%s","asarSha256":"%s"}\n' "$version" "$exe_hash" "$asar_hash" > "$folder/launch-manifest.json"
}
wait_marker() {
  local file="$1" i
  for i in 1 2 3 4 5; do if [ -f "$file" ]; then return 0; fi; sleep 1; done
  echo "Missing expected fake marker: $file" >&2; return 1
}

A="$T/only-release"; mkdir -p "$A"; cp "$ROOT/启动机器人.exe" "$A/启动机器人.exe"
make_package "$A" 0.9.1 release
"$A/启动机器人.exe" --check-launch-version=0.9.1
if "$A/启动机器人.exe" --check-launch-version=0.9.2; then echo 'Wrong expected version should be rejected' >&2; exit 1; fi
test ! -e "$A/release-v0.9.1/win-unpacked/marker.txt"
"$A/启动机器人.exe"
wait_marker "$A/release-v0.9.1/win-unpacked/marker.txt"
echo 'PASS only latest release'
mkdir -p "$A/scripts"; cp "$ROOT/scripts/launcher.exe" "$A/scripts/launcher.exe"
rm "$A/release-v0.9.1/win-unpacked/marker.txt"
"$A/scripts/launcher.exe"
wait_marker "$A/release-v0.9.1/win-unpacked/marker.txt"
echo 'PASS scripts/launcher.exe shares the root selector'

B="$T/secure-and-release"; mkdir -p "$B"; cp "$ROOT/启动机器人.exe" "$B/启动机器人.exe"
make_package "$B" 0.9.0 secure
make_package "$B" 0.9.1 release
"$B/启动机器人.exe" --check-launch-version=0.9.1
if "$B/启动机器人.exe" --check-launch-version=0.9.0; then echo 'Older secure fallback should not pass release verification' >&2; exit 1; fi
"$B/启动机器人.exe"
wait_marker "$B/release-v0.9.1/win-unpacked/marker.txt"
test ! -e "$B/artifacts/mcp-secure-remote/packaged/win-unpacked/marker.txt"
echo 'PASS newer release beats older secure artifact'

C="$T/missing-or-corrupt"; mkdir -p "$C"; cp "$ROOT/启动机器人.exe" "$C/启动机器人.exe"
if "$C/启动机器人.exe" --check-launch-target; then echo 'Missing package should be rejected' >&2; exit 1; fi
make_package "$C" 0.9.2 release
printf 'tampered' >> "$C/release-v0.9.2/win-unpacked/QQ AI Bot.exe"
if "$C/启动机器人.exe" --check-launch-target; then echo 'Corrupt package should be rejected' >&2; exit 1; fi
make_package "$C" 0.9.1 secure
if "$C/启动机器人.exe" --check-launch-version=0.9.2; then echo 'Corrupt newest release should not pass verification' >&2; exit 1; fi
"$C/启动机器人.exe"
wait_marker "$C/artifacts/mcp-secure-remote/packaged/win-unpacked/marker.txt"
echo 'PASS missing/corrupt package rejected; verified fallback used'

D="$T/same-version"; mkdir -p "$D"; cp "$ROOT/启动机器人.exe" "$D/启动机器人.exe"
make_package "$D" 0.9.1 secure
make_package "$D" 0.9.1 release
touch -d '2026-01-01 UTC' "$D/artifacts/mcp-secure-remote/packaged/win-unpacked/QQ AI Bot.exe"
"$D/启动机器人.exe"
wait_marker "$D/release-v0.9.1/win-unpacked/marker.txt"
test ! -e "$D/artifacts/mcp-secure-remote/packaged/win-unpacked/marker.txt"
echo 'PASS equal versions choose newest verified build'
