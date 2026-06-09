# Releasing Prompty

End-to-end runbook for shipping a signed, notarized, auto-updating DMG. Block G of `PLAN.md`.

## One-time Apple setup

### 1. Enroll in the Apple Developer Program

- Sign up at <https://developer.apple.com/programs/enroll/> ($99 / year).
- Note your **Team ID** (10 chars, visible at <https://developer.apple.com/account>). This becomes `APPLE_TEAM_ID`.

### 2. Create a "Developer ID Application" certificate

We sign the .app and .dmg with a "Developer ID Application" cert (NOT the Mac App Store cert).

1. In Xcode → Settings → Accounts → your Apple ID → Manage Certificates → `+` → **Developer ID Application**.
2. The cert lands in your login Keychain. Open Keychain Access, find it (named `Developer ID Application: Your Name (TEAMID)`), right-click → Export.
3. Choose `.p12`, set a password, save.
4. Encode for CI:

   ```sh
   base64 -i DeveloperID.p12 -o DeveloperID.p12.base64
   ```

   The contents of that file become `CSC_LINK`. The password becomes `CSC_KEY_PASSWORD`.
5. The full identity string (e.g. `Developer ID Application: Sahil Kathpal (ABCD123456)`) becomes `APPLE_DEVELOPER_ID`. You can read it via `security find-identity -v -p codesigning`.

### 3. Generate an app-specific password for notarization

1. Sign in to <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords → `+`.
2. Label it "Prompty notarytool" and save the generated password — this becomes `APPLE_APP_SPECIFIC_PASSWORD`.
3. Your Apple ID email becomes `APPLE_ID`.

### 4. (Future) Register a Services ID for Sign in with Apple

Not required for releasing, but Block C will need it. Register at developer.apple.com → Identifiers → Services IDs.

## GitHub secrets

Add all of the following to **Settings → Secrets and variables → Actions** in the `prompty` repo:

| Secret | Purpose |
|---|---|
| `APPLE_DEVELOPER_ID` | Full identity string used by `codesign` and electron-builder, e.g. `Developer ID Application: Sahil Kathpal (TEAMID)`. |
| `APPLE_TEAM_ID` | 10-character team ID, used by `notarytool`. |
| `APPLE_ID` | Apple ID email for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated at appleid.apple.com. |
| `CSC_LINK` | Base64-encoded `.p12` certificate (Developer ID Application). |
| `CSC_KEY_PASSWORD` | Password protecting that `.p12`. |

## Cutting a release

```sh
# bump version in app/package.json, commit
git tag v0.1.0
git push --tags
```

The `release` workflow in `.github/workflows/release.yml` runs on `macos-14`, builds the Swift sidecar, signs it, builds the Electron app, signs the .app, notarizes it via `notarytool`, packages a universal DMG, and uploads:

- `Prompty-0.1.0-arm64.dmg` + `.blockmap`
- `Prompty-0.1.0-x64.dmg` + `.blockmap`
- `latest-mac.yml`

to the GitHub Release for the tag.

## Auto-update feed

`electron-updater` (Block G4) is configured with:

```yaml
publish:
  provider: generic
  url: https://updates.prompty.app/mac/
```

You need to host the release artifacts at that URL so installed copies can find updates. Layout:

```
https://updates.prompty.app/mac/
├── latest-mac.yml                          # version manifest electron-updater fetches
├── Prompty-0.1.0-arm64.dmg
├── Prompty-0.1.0-arm64.dmg.blockmap        # delta-update info
├── Prompty-0.1.0-x64.dmg
└── Prompty-0.1.0-x64.dmg.blockmap
```

Recommended hosting: **Cloudflare R2** with a public bucket bound to a custom domain (`updates.prompty.app`). Alternatives: Cloudflare Pages, S3 + CloudFront, GitHub release URLs (with `provider: github` instead of `generic`).

After the release workflow finishes, download the assets from the GitHub release and upload them to R2 (the workflow doesn't push there yet — manual step or extend the workflow with `wrangler r2 object put`).

## Local dev — no Apple creds required

- `npm install` and `npm run build` work offline. The sidecar prebuild step calls `swift build -c release`; if `swift` is missing it warns and skips. If `APPLE_DEVELOPER_ID` is unset, the sidecar is built but not codesigned (logged as "skipping codesign").
- `npm run dev` never touches any Apple machinery.
- `npm run dist` requires the secrets above — only run it locally if you've configured everything per the table.

## Verifying a signed build locally

```sh
# After `npm run dist`:
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Prompty.app
spctl -a -t exec -vv release/mac-arm64/Prompty.app
xcrun stapler validate release/Prompty-*.dmg
```

All three should report success once notarization has completed and the ticket is stapled.
