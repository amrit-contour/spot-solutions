#!/usr/bin/env bash
# Builds "Spot Server.app" (universal: Apple Silicon + Intel) and SpotServer.dmg.
#   deploy/mac/build.sh [out-dir]
# Needs only the Xcode command-line tools. Ad-hoc signed (no Apple Developer account).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-$PWD/dist}"
APP="$OUT/Spot Server.app"
TMP="$(mktemp -d)"
VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "▸ Compiling"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -parse-as-library -target "$arch-apple-macos13.0" \
    -framework SwiftUI -framework WebKit -framework AppKit \
    SpotServer/main.swift -o "$TMP/SpotServer-$arch"
done
lipo -create "$TMP/SpotServer-arm64" "$TMP/SpotServer-x86_64" -output "$APP/Contents/MacOS/SpotServer"

echo "▸ Bundling"
cp spotctl "$APP/Contents/Resources/spotctl"
chmod +x "$APP/Contents/Resources/spotctl"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Nothing BOT Server</string>
  <key>CFBundleDisplayName</key><string>Nothing BOT Server</string>
  <key>CFBundleIdentifier</key><string>app.spotsolutions.server</string>
  <key>CFBundleExecutable</key><string>SpotServer</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The embedded console is plain HTTP on 127.0.0.1. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF

echo "▸ Icon"
ICONSET="$TMP/AppIcon.iconset"; mkdir -p "$ICONSET"
SRC=../../apps/web/public/icons/icon-512.png
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [[ $d -le 512 ]] && sips -z $d $d "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null || echo "  (icon skipped)"

echo "▸ Signing (ad-hoc)"
codesign --force --deep --sign - "$APP"

echo "▸ Disk image"
STAGE="$TMP/dmg"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT/SpotServer.dmg"
hdiutil create -quiet -volname "Nothing BOT Server" -srcfolder "$STAGE" -ov -format UDZO "$OUT/SpotServer.dmg"
rm -rf "$TMP"
echo "✓ $APP"
echo "✓ $OUT/SpotServer.dmg"
