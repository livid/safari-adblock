#!/bin/bash
# Builds a notarized Shield.app and publishes it as a GitHub release: a disk image for people
# to download, and a zip with the Sparkle appcast that installed copies update from.
#
#   tools/release.sh --notes notes.md     build, notarize, sign, publish
#   tools/release.sh --dry-run            the same, without publishing (output in dist/)
#   tools/release.sh --no-notarize        build and sign only, to test the pipeline
#
# The version is the one in extension/manifest.json; the build number (what Sparkle compares)
# is the commit count. Bump the manifest version, commit and push before releasing.
#
# Needs on this Mac, once:
#   - the "Developer ID Application" certificate for team 66KP7KX9MX in the login keychain
#   - a notarytool keychain profile for the team, named exe-notary (or set NOTARY_PROFILE):
#       xcrun notarytool store-credentials exe-notary --apple-id <Apple ID> --team-id 66KP7KX9MX
#   - Shield's Sparkle signing key (keychain account io.github.livid.Shield; see README)
#   - gh, logged in
# Over SSH, unlock the login keychain first: security unlock-keychain ~/Library/Keychains/login.keychain-db

set -euo pipefail

REPO=livid/safari-adblock
TEAM=66KP7KX9MX
NOTARY_PROFILE=${NOTARY_PROFILE:-exe-notary} # a notarytool keychain profile for team 66KP7KX9MX
SPARKLE_VERSION=2.10.1 # keep in step with the package pin in Shield/Shield.xcodeproj
SPARKLE_DIGEST=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
SPARKLE_ACCOUNT=io.github.livid.Shield

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST=$ROOT/dist
SPARKLE_BIN=$ROOT/tools/.sparkle/$SPARKLE_VERSION/bin

publish=1 notarize=1 notes=""
while [ $# -gt 0 ]; do
  case $1 in
    --notes) notes=$2; shift 2 ;;
    --dry-run) publish=0; shift ;;
    --no-notarize) publish=0 notarize=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Building registers each copy of the app with macOS, and Safari then runs the extension from
# whichever copy it picked last, even a temporary one. So on exit, unregister every copy under
# dist/ (Safari goes back to the one you installed or built), and remove the exported key.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
keydir=""
cleanup() {
  [ -n "$keydir" ] && rm -rf "$keydir"
  [ -d "$DIST" ] || return 0
  find "$DIST" -name "*.app" -type d -prune 2>/dev/null | while read -r copy; do
    "$LSREGISTER" -u "$copy" 2>/dev/null || true
    pluginkit -r "$copy/Contents/PlugIns/Shield Extension.appex" 2>/dev/null || true
  done
}
trap cleanup EXIT

cd "$ROOT"
version=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' extension/manifest.json)
build=$(git rev-list --count HEAD)
tag=v$version
zip_name=Shield-$version.zip
dmg_name=Shield-$version.dmg
DMGBUILD_ENV=$ROOT/tools/.cache/dmgbuild

# ---------------------------------------------------------------- checks

step "Shield $version (build $build)"
if [ -n "$(git status --porcelain)" ]; then
  [ $publish = 0 ] || fail "the working tree has uncommitted changes"
  echo "warning: building uncommitted changes (fine for a dry run, never published)"
fi
if [ $publish = 1 ]; then
  [ -n "$notes" ] && [ -f "$notes" ] || fail "--notes <file> is required to publish (Markdown, shown on GitHub and in the update dialog)"
  git fetch -q origin
  git merge-base --is-ancestor HEAD origin/main || fail "HEAD isn't pushed to origin/main"
  ! gh release view "$tag" --repo "$REPO" >/dev/null 2>&1 || fail "release $tag already exists; bump the version in extension/manifest.json"
fi

if [ ! -x "$SPARKLE_BIN/sign_update" ]; then
  step "Downloading Sparkle $SPARKLE_VERSION tools"
  mkdir -p "$ROOT/tools/.sparkle/$SPARKLE_VERSION"
  tarball=$(mktemp -d)/Sparkle.tar.xz
  curl -sSfL -o "$tarball" "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
  [ "$(shasum -a 256 "$tarball" | cut -d' ' -f1)" = "$SPARKLE_DIGEST" ] || fail "Sparkle download doesn't match its published digest"
  tar -xf "$tarball" -C "$ROOT/tools/.sparkle/$SPARKLE_VERSION"
fi

if [ ! -x "$DMGBUILD_ENV/bin/dmgbuild" ]; then
  step "Installing dmgbuild"
  rm -rf "$DMGBUILD_ENV"
  python3 -m venv "$DMGBUILD_ENV"
  "$DMGBUILD_ENV/bin/pip" install -q --disable-pip-version-check --require-hashes --no-deps -r tools/dmg-requirements.txt
fi

# Sends a zip or disk image to Apple's notary service and waits for the verdict.
notarize_file() {
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait \
    --output-format json >"$DIST/notary.json" || true
  status=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$DIST/notary.json" 2>/dev/null || true)
  if [ "$status" != "Accepted" ]; then
    cat "$DIST/notary.json" >&2 || true
    id=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$DIST/notary.json" 2>/dev/null || true)
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2 || true
    fail "notarization status: ${status:-none}"
  fi
}

# ---------------------------------------------------------------- build

rm -rf "$DIST" && mkdir -p "$DIST"

step "Archiving"
xcodebuild -quiet -project Shield/Shield.xcodeproj -scheme Shield -configuration Release \
  -destination "generic/platform=macOS" -derivedDataPath "$DIST/DerivedData" \
  -archivePath "$DIST/Shield.xcarchive" -allowProvisioningUpdates \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" archive

step "Exporting with Developer ID"
xcodebuild -quiet -exportArchive -archivePath "$DIST/Shield.xcarchive" -exportPath "$DIST/export" \
  -exportOptionsPlist tools/ExportOptions.plist -allowProvisioningUpdates
app=$DIST/export/Shield.app

step "Checking signatures"
codesign --verify --deep --strict "$app"
for bundle in "$app" "$app/Contents/PlugIns/Shield Extension.appex" "$app/Contents/Frameworks/Sparkle.framework"; do
  info=$(codesign -dvv "$bundle" 2>&1)
  grep -q "Authority=Developer ID Application:" <<<"$info" || fail "$bundle isn't signed with Developer ID"
  grep -q "TeamIdentifier=$TEAM" <<<"$info" || fail "$bundle isn't signed by team $TEAM"
done
! codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q get-task-allow || fail "the export kept the debugging entitlement"
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$2"; }
[ "$(plist CFBundleShortVersionString "$app/Contents/Info.plist")" = "$version" ] || fail "app version mismatch"
[ "$(plist CFBundleVersion "$app/Contents/Info.plist")" = "$build" ] || fail "build number mismatch"
echo "Developer ID, team $TEAM, version $version ($build)"

# ---------------------------------------------------------------- notarize

if [ $notarize = 1 ]; then
  step "Notarizing (this usually takes a few minutes)"
  ditto -c -k --keepParent "$app" "$DIST/notarize.zip"
  notarize_file "$DIST/notarize.zip"
  rm "$DIST/notarize.zip"

  step "Stapling"
  xcrun stapler staple -q "$app"
  xcrun stapler validate -q "$app"
  spctl --assess --type execute -vv "$app" 2>&1 | grep -q "source=Notarized Developer ID" || fail "Gatekeeper doesn't accept the app"
  echo "accepted by Gatekeeper as Notarized Developer ID"
fi

# ---------------------------------------------------------------- package and sign the update

step "Packaging $zip_name"
ditto -c -k --sequesterRsrc --keepParent "$app" "$DIST/$zip_name"

step "Signing the update for Sparkle"
# Only generate_keys, which created the key, may read it without a prompt (impossible over
# SSH), so it hands the key to sign_update through a private file that is removed at once.
keydir=$(mktemp -d)
"$SPARKLE_BIN/generate_keys" --account "$SPARKLE_ACCOUNT" -x "$keydir/key" >/dev/null
signed=$("$SPARKLE_BIN/sign_update" --ed-key-file "$keydir/key" "$DIST/$zip_name")
rm -rf "$keydir"
signature=$(sed -E 's/.*sparkle:edSignature="([^"]+)".*/\1/' <<<"$signed")
length=$(sed -E 's/.*length="([0-9]+)".*/\1/' <<<"$signed")
# The signature must verify against the public key inside the app being shipped.
swift "$ROOT/tools/verify-update-signature.swift" "$(plist SUPublicEDKey "$app/Contents/Info.plist")" \
  "$DIST/$zip_name" "$signature"

step "Writing appcast.xml"
python3 -I - "$DIST/appcast.xml" "$version" "$build" "$(plist LSMinimumSystemVersion "$app/Contents/Info.plist")" \
  "https://github.com/$REPO/releases/download/$tag/$zip_name" "$length" "$signature" \
  "https://github.com/$REPO/releases/tag/$tag" "${notes:-/dev/null}" <<'PY'
import html, sys
from email.utils import formatdate
out, version, build, min_os, url, length, signature, page, notes = sys.argv[1:]

# Release notes as simple HTML for Sparkle's update dialog: "- " lines become a list.
parts, items = [], []
for line in open(notes, encoding="utf-8").read().splitlines():
    line = line.strip()
    if line.startswith(("- ", "* ")):
        items.append(f"<li>{html.escape(line[2:])}</li>")
        continue
    if items:
        parts.append("<ul>" + "".join(items) + "</ul>"); items = []
    if line and not line.startswith("#"):
        parts.append(f"<p>{html.escape(line)}</p>")
if items:
    parts.append("<ul>" + "".join(items) + "</ul>")
description = "".join(parts) or f'<p>See the <a href="{html.escape(page)}">release notes</a>.</p>'

q = lambda s: html.escape(s, quote=True)
open(out, "w", encoding="utf-8").write(f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Shield for Safari</title>
    <link>https://github.com/livid/safari-adblock</link>
    <item>
      <title>Shield {q(version)}</title>
      <pubDate>{formatdate(usegmt=True)}</pubDate>
      <sparkle:version>{q(build)}</sparkle:version>
      <sparkle:shortVersionString>{q(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{q(min_os)}</sparkle:minimumSystemVersion>
      <sparkle:fullReleaseNotesLink>{q(page)}</sparkle:fullReleaseNotesLink>
      <description><![CDATA[{description}]]></description>
      <enclosure url="{q(url)}" length="{q(length)}" type="application/octet-stream" sparkle:edSignature="{q(signature)}"/>
    </item>
  </channel>
</rss>
""")
PY
xmllint --noout "$DIST/appcast.xml"
echo "$DIST/appcast.xml"

# ---------------------------------------------------------------- disk image

# What people download: Shield next to an Applications shortcut, on a background that shows
# the version and says to drag one onto the other.
step "Building $dmg_name"
swift tools/dmg-background.swift "$version" "$DIST/dmg-background.png" 1
swift tools/dmg-background.swift "$version" "$DIST/dmg-background@2x.png" 2
tiffutil -cathidpicheck "$DIST/dmg-background.png" "$DIST/dmg-background@2x.png" -out "$DIST/dmg-background.tiff" 2>/dev/null
"$DMGBUILD_ENV/bin/dmgbuild" -s tools/dmg-settings.py -D app="$app" -D background="$DIST/dmg-background.tiff" \
  "Shield $version" "$DIST/$dmg_name" 2> >(grep -v "is deprecated" >&2) >/dev/null
rm "$DIST"/dmg-background*
codesign --sign "Developer ID Application" --timestamp "$DIST/$dmg_name"
# Captured first: with pipefail, grep -q can end the pipe before codesign has finished writing.
info=$(codesign -dvv "$DIST/$dmg_name" 2>&1)
grep -q "TeamIdentifier=$TEAM" <<<"$info" || fail "the disk image isn't signed by team $TEAM"

if [ $notarize = 1 ]; then
  step "Notarizing the disk image"
  notarize_file "$DIST/$dmg_name"
  xcrun stapler staple -q "$DIST/$dmg_name"
  xcrun stapler validate -q "$DIST/$dmg_name"
  info=$(spctl --assess --type open --context context:primary-signature -vv "$DIST/$dmg_name" 2>&1 || true)
  grep -q "source=Notarized Developer ID" <<<"$info" || fail "Gatekeeper doesn't accept the disk image"
  echo "accepted by Gatekeeper as Notarized Developer ID"
fi

# ---------------------------------------------------------------- publish

if [ $publish = 0 ]; then
  step "Not published (dry run). Output: $DIST"
  exit 0
fi

step "Publishing $tag on GitHub"
gh release create "$tag" "$DIST/$dmg_name" "$DIST/$zip_name" "$DIST/appcast.xml" --repo "$REPO" \
  --target "$(git rev-parse HEAD)" --title "Shield $version" --notes-file "$notes"

step "Checking what installed copies will see"
live=$(curl -sSfL "https://github.com/$REPO/releases/latest/download/appcast.xml")
grep -q "<sparkle:version>$build</sparkle:version>" <<<"$live" || fail "the latest appcast isn't this release yet"
echo "https://github.com/$REPO/releases/latest/download/appcast.xml now offers $version ($build)"
