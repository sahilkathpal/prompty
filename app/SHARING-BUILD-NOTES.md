# Sharing Prompty without an Apple Developer ID (local notes)

Local-only runbook for building a signed-but-not-notarized Prompty.app and handing
it to someone directly. **Not committed.** No paid Apple Developer ID ($99/yr) needed.

## TL;DR — build & package

```bash
cd app
npm run build
npx electron-builder --mac --config electron-builder.yml -c.mac.identity="Prompty Local Signing"
```

Output (both arches) in `app/release/`:

- `Prompty-0.1.0-arm64.dmg` → Apple Silicon (M-series)
- `Prompty-0.1.0.dmg`       → Intel

Requires macOS **14.4+** on both build and target machines (Core Audio process tap).
`swift` must be on PATH (Xcode / Command Line Tools) or the audio sidecar won't embed.

## Why the `-c.mac.identity=...` override

`electron-builder.yml` sets `identity: ${env.APPLE_DEVELOPER_ID}`, but this
electron-builder version (24.13.3) does **not** expand that `${env.*}` macro — it
looks for a keychain cert literally named `${env.APPLE_DEVELOPER_ID}`, fails, and
**skips signing entirely**. An unsigned bundle is killed as "damaged" on Apple Silicon.

So we override on the CLI with the self-signed cert that already exists in the
login keychain: **`Prompty Local Signing`** (SHA1 `DFC6133197593DBDCCDDA9EDD38A9DD9071EBBBC`).

- Do **not** rely on `CSC_IDENTITY_AUTO_DISCOVERY=false` or `-c.mac.identity=null`
  here — both produce a missing/stale signature that fails `codesign --verify`.
- `npm run dist` won't work either, because it can't inject the CLI identity override.
- Notarization auto-skips (no `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`).

If the `Prompty Local Signing` cert is ever missing, recreate a self-signed code-signing
cert with that exact name via Keychain Access → Certificate Assistant → Create a
Certificate (Identity type: Self Signed Root, Certificate type: Code Signing).

## Verify the build

```bash
codesign --verify --deep --strict app/release/mac-arm64/Prompty.app && echo OK
codesign -dv --verbose=2 app/release/mac-arm64/Prompty.app 2>&1 | grep -E "Identifier|Authority|flags"
# expect: Identifier=app.prompty.desktop, Authority=Prompty Local Signing, flags=...(runtime)
```

## App icon (ruby placeholder)

The Dock icon is a code-drawn ruby placeholder at `app/build/icon.icns`
(electron-builder auto-detects that path). To regenerate / replace:

```bash
swift /tmp/ruby_icon.swift          # writes /tmp/icon_1024.png  (generator is local-only)
# or drop your own 1024x1024 PNG at /tmp/icon_1024.png, then:
ICO=/tmp/icon.iconset; rm -rf "$ICO"; mkdir -p "$ICO"
for s in 16 32 128 256 512; do
  sips -z $s $s /tmp/icon_1024.png --out "$ICO/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) /tmp/icon_1024.png --out "$ICO/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICO" -o app/build/icon.icns
```

## Dock icon changes (currently uncommitted)

Showing a Dock icon required two edits (still in the working tree, not committed):

- `electron-builder.yml` — removed `LSUIElement: true` from `mac.extendInfo`.
- `electron/main.ts` — removed the `app.dock?.hide()` call.

Clicking the Dock icon opens the main window (existing `app.on("activate")` handler).
The floating overlay/teleprompter still appear over fullscreen calls because they set
`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.

## Hand-off instructions (give these to the recipient)

1. Open the DMG that matches their Mac, drag **Prompty** to Applications.
2. Clear Gatekeeper (signed by an untrusted self-signed cert, not notarized).
   The recursive `-r` matters — it also un-quarantines the embedded audio sidecar,
   otherwise far-end ("them") audio silently never starts:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Prompty.app
   ```
   (GUI alternative: try to open → blocked → System Settings → Privacy & Security → Open Anyway.)
3. Launch it. It's a menu-bar + Dock app; clicking the ruby opens the main window.
4. Click **Allow** on the microphone prompt (or System Settings → Privacy & Security →
   Microphone → enable Prompty).
5. **Set the Deepgram key.** There is no sign-in. Transcription reads
   `DEEPGRAM_API_KEY` from the environment, so launch the app with it set, e.g.:
   ```bash
   DEEPGRAM_API_KEY=<key> open /Applications/Prompty.app
   ```
   (A real env var always wins. The app also reads a gitignored `.env` at the
   repo root when launched from the source tree — that path is for dev, not the
   packaged hand-off.)

### Permissions notes

- **Microphone** is the only permission the recipient grants. The grant covers the
  bundled sidecar (spawned by Prompty, lives inside the signed bundle).
- **System audio** ("them") uses the Core Audio process tap — no Screen Recording,
  no prompt, works once the app runs.
- No certificate, Screen Recording, or Accessibility permission is needed by the recipient.
- Granted-but-silent mic? Toggle Microphone for Prompty in System Settings and relaunch.

## Caveats

- **No auto-update.** The Sparkle update feed needs Apple-signed/notarized builds; push a
  new build by rebuilding and re-sending the DMG.
- Keep signing with the **same** `Prompty Local Signing` cert across rebuilds — TCC
  (mic) grants are tied to the signature, so reusing it preserves the recipient's grant.
