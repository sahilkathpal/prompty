# Ruby OTA Auto-Update Plan

How to give the shipped macOS app over-the-air updates, so a downloaded build can
update itself instead of users re-downloading a DMG (the current hand-off model in
`app/RELEASING.md`).

## Current state

**Half wired already:**
- `app/electron/electron-builder.yml` declares an update feed:
  `publish: { provider: generic, url: https://updates.prompty.app/mac/ }`.
  electron-builder will emit the `latest-mac.yml` manifest the updater needs.
- A notarization hook exists: `afterSign: scripts/notarize.mjs`.

**Missing (why it doesn't update today):**
- `electron-updater` is not a dependency, and `autoUpdater` is never called. A
  downloaded build never checks the feed → never updates.
- The MVP ships **self-signed, not notarized** (RELEASING.md). macOS auto-update
  (Squirrel.Mac) **refuses unsigned/untrusted updates**, so real Developer ID
  signing + notarization is a hard prerequisite — which the team is moving to.

## Hard prerequisites (must all hold for OTA to work)

1. **Paid Apple Developer ID** + a *Developer ID Application* certificate.
2. **Real signing in the build.** Today `electron-builder.yml` has `mac.sign: false`
   and `identity: ${env.APPLE_DEVELOPER_ID}`, but the pinned electron-builder does
   not expand that `${env.*}` macro (see RELEASING.md), so signing is currently
   done with a CLI override + a self-signed cert. For OTA: enable signing with the
   real Developer ID cert and drop the self-signed workaround.
3. **Notarization on** for every published build (`scripts/notarize.mjs` already
   exists — confirm it runs with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
   `APPLE_TEAM_ID` creds).
4. **Same Apple Team ID across releases.** Squirrel.Mac validates the update's
   signature; a team/identity change breaks the update path (and resets the TCC
   mic grant).
5. **The updater must ship inside the FIRST public signed build.** Versions that
   don't contain `autoUpdater` can never self-update — those users are stranded on
   manual re-download. So wire the updater *before* the first real release, not
   after.
6. **macOS packaging:** ship a `zip` target alongside the `dmg` (Squirrel.Mac
   updates from the zip; `latest-mac.yml` references it). The app must run from
   `/Applications` and not be quarantine-translocated.

## Implementation

### 1. Dependency
- `npm i electron-updater` (in `app/`).

### 2. Updater module — `app/electron/updater.ts`
- Import `autoUpdater` from `electron-updater`; attach a logger.
- **Guard:** only run when `app.isPackaged` and not in E2E (`PROMPTY_E2E`), so dev
  and tests never hit the feed. No-op otherwise.
- Config: `autoUpdater.autoDownload = true`, `autoUpdater.autoInstallOnAppQuit = true`.
- `checkForUpdates()` on launch (a few seconds after ready) and on an interval
  (e.g. every 6h).
- Wire events: `checking-for-update`, `update-available`, `update-not-available`,
  `download-progress`, `update-downloaded`, `error` — each logs and emits a
  product-analytics event (we already have `analytics.capture`): `update_available`,
  `update_downloaded`, `update_error`, `update_installed`.
- Expose `installUpdateNow()` → `autoUpdater.quitAndInstall()` for an explicit
  "Restart to update" action.

### 3. Wire into `app/electron/main.ts`
- Call `initUpdater()` from the `app.on("ready")` path (after windows/tray exist),
  guarded by `app.isPackaged`.
- The existing `before-quit` flush already drains analytics; `autoInstallOnAppQuit`
  applies a downloaded update on the natural quit.

### 4. UX (recommended: quiet, non-blocking)
- Background download (no prompt while downloading).
- On `update-downloaded`: surface a subtle affordance — a tray menu item
  **“Restart to update”** and/or a dismissible banner in the main window
  ("An update is ready — restart Ruby to apply"). Installs automatically on next
  quit regardless.
- No modal interruptions mid-call. If a call is live, defer any restart prompt.

### 5. Build/release pipeline (`electron-builder.yml` + CI)
- Set `mac.sign: true`, real Developer ID identity (fix the `${env.*}` expansion or
  pass via CLI), keep `afterSign: scripts/notarize.mjs`.
- Ensure `mac.target` includes both `dmg` and `zip`.
- Publish: `electron-builder --mac --publish always` uploads `*.dmg`, `*.zip`, and
  `latest-mac.yml` to the generic feed. Host `updates.prompty.app/mac/` must serve
  these over HTTPS.
- Bump `version` in `package.json` each release (electron-updater compares semver
  from `latest-mac.yml`).
- Update `app/RELEASING.md` to document the signed + notarized + publish flow
  (current doc explicitly says self-signed / no auto-update).

### 6. Safety / control
- **Kill switch via PostHog feature flag** (we now have PostHog): gate
  `checkForUpdates()` behind a flag so a bad release can be halted remotely.
- **Staged rollout:** electron-updater honors `stagingPercentage` in
  `latest-mac.yml` — ramp a release to a fraction of users first.
- **No downgrade:** the updater only moves forward; "rollback" = publish a higher
  patch. So test each release on a clean Mac before publishing.
- Keep the manual DMG hand-off as a fallback.

## Testing
- Point a dev/staging build at a test feed via `dev-app-update.yml`, or do a real
  two-version test: install vN signed+notarized, publish vN+1, confirm the running
  app downloads and applies it on restart.
- Verify trust: `codesign --verify --deep --strict`, `spctl -a -vv`,
  `xcrun stapler validate` on the built `.app`.
- Confirm the full loop on a clean Mac in `/Applications`.

## Sequencing
The updater **code** is small (~a module + a few lines in main + a tray item). The
real work is the **release pipeline**: Developer ID signing, notarization, the
publish step, and hosting `updates.prophy.app/mac/`. Because the updater must be
present in the first public build, wire the code now (behind `app.isPackaged`) so
it rides the first signed release.

## Open questions
- UX: silent install-on-quit only, or also an in-app "Restart now" prompt?
- Cadence: check on launch only, or also periodically (6h)?
- Hosting: who/what serves `updates.prompty.app` (S3+CloudFront, a static host)?
- CI: which runner does the signed+notarized build + publish?
- Do we want the PostHog feature-flag kill switch in v1, or add later?
