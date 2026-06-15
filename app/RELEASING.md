# Releasing Prompty

The MVP ships as a locally self-signed (not notarized) DMG handed directly to a
design partner. No paid Apple Developer ID, no notarization, no auto-update feed.

## Build & package

From `app/`:

```bash
npm run build
npx electron-builder --mac --config electron-builder.yml -c.mac.identity="Prompty Local Signing"
```

Output (both arches) lands in `app/release/`:

- `Prompty-0.1.0-arm64.dmg` → Apple Silicon (M-series)
- `Prompty-0.1.0.dmg`       → Intel

Requires macOS **14.4+** on both the build and target machines (the CoreAudio
process tap needs it). `swift` must be on PATH (Xcode or Command Line Tools) or
the audio sidecar won't embed.

### Why the `-c.mac.identity=...` override

`electron-builder.yml` sets `identity: ${env.APPLE_DEVELOPER_ID}`, but the pinned
electron-builder version does not expand that `${env.*}` macro — it looks for a
keychain cert literally named `${env.APPLE_DEVELOPER_ID}`, fails, and skips signing
entirely. An unsigned bundle is killed as "damaged" on Apple Silicon. So we
override on the CLI with a self-signed cert in the login keychain named
**`Prompty Local Signing`**.

If that cert is missing, recreate a self-signed code-signing cert with that exact
name via Keychain Access → Certificate Assistant → Create a Certificate (Identity
type: Self Signed Root, Certificate type: Code Signing).

Keep signing with the **same** cert across rebuilds — the recipient's microphone
(TCC) grant is tied to the signature, so reusing it preserves their grant.

## Verify the build

```bash
codesign --verify --deep --strict app/release/mac-arm64/Prompty.app && echo OK
codesign -dv --verbose=2 app/release/mac-arm64/Prompty.app 2>&1 | grep -E "Identifier|Authority|flags"
# expect: Identifier=app.prompty.desktop, Authority=Prompty Local Signing, flags=...(runtime)
```

## Hand-off instructions (give these to the recipient)

1. Open the DMG that matches their Mac, drag **Prompty** to Applications.
2. Clear Gatekeeper (the build is self-signed and not notarized). The recursive
   `-r` matters — it also un-quarantines the embedded audio sidecar, otherwise
   far-end ("them") audio silently never starts:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Prompty.app
   ```

   (GUI alternative: try to open → blocked → System Settings → Privacy & Security
   → Open Anyway.)
3. Launch it. Clicking the ruby opens the main window.
4. Click **Allow** on the microphone prompt (or System Settings → Privacy &
   Security → Microphone → enable Prompty).
5. Set the Deepgram key. Transcription reads `DEEPGRAM_API_KEY` from the
   environment / `.env`; the recipient needs a key configured the same way.

### Permissions notes

- **Microphone** is the only permission the recipient grants. The grant covers the
  bundled sidecar (spawned by Prompty, lives inside the signed bundle).
- **System audio** ("them") uses the CoreAudio process tap — no Screen Recording
  permission, no prompt; it works once the app runs.
- Granted-but-silent mic? Toggle Microphone for Prompty in System Settings and
  relaunch.

## Caveat

No auto-update. To ship a change, rebuild and re-send the DMG.
