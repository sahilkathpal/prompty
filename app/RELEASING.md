# Releasing Ruby

Ruby ships as a **signed (Apple Developer ID) + notarized + stapled** macOS build and
auto-updates in the field via `electron-updater` from the generic feed at
`https://updates.codeongrass.com/ruby/mac/` (see `electron-builder.yml` → `publish`).

The update *infrastructure* (DNS, the DO Space + CDN, the TLS cert and its renewal) is
documented in **`RUBY_OTA_SPACES_CUTOVER.md`** at the repo root. This file is the
per-release **build → publish → verify** runbook.

---

## Versioning (the discipline)

- **Semver**, and the git tag is the source of truth alongside `app/package.json`:
  **the annotated tag `vX.Y.Z` MUST equal `app/package.json` `version`.** That version
  flows to `app.getVersion()`, the analytics base props, and the OTA `latest-mac.yml`.
- Releases are cut on the **`ruby-rebuild`** trunk. Each release is a dedicated
  **version-bump commit** (`release: vX.Y.Z — …`) with an **annotated tag** on it.
- Patch = bug fix (0.1.0 → 0.1.1). Minor = features. We are pre-1.0, so minor/patch
  semantics are loose but a fix is always a patch.

Cut the version:

```bash
# on ruby-rebuild, tree clean
# edit app/package.json "version" → X.Y.Z
git commit -am "release: vX.Y.Z — <one-line summary>"
git tag -a vX.Y.Z -m "Ruby X.Y.Z — <summary>"
```

---

## Prerequisites (one-time on the build machine)

- **macOS 14.4+** and `swift` on `PATH` (Xcode / Command Line Tools) — the CoreAudio
  process tap needs 14.4, and the Swift audio sidecar is built by
  `scripts/prebuild-sidecar.mjs`.
- **Apple Developer ID Application** certificate in the login keychain (paid Apple
  Developer account). Confirm with `security find-identity -v -p codesigning`.
- **Signing + notarization env** — put these in **`app/.env.local`** (gitignored);
  `npm run dist` auto-loads it (before the build, so the sidecar sign step sees it too).
  Note the **two identity vars**: it's the *same* cert in *two formats*, because the
  sidecar's `codesign` and electron-builder disagree on the prefix.

  | Var | Used by | Value / format |
  |---|---|---|
  | `CSC_NAME` | electron-builder (app signing) | Identity name **without** the type prefix, e.g. `Anil Dukkipatty (9NM63KP2JC)`. electron-builder **rejects** the `Developer ID Application:` prefix. Honored only because `mac.identity` is unset in `electron-builder.yml` — do **not** re-add a `mac.identity` / `${env.*}` key, the pinned electron-builder won't expand it and falls back to ad-hoc. |
  | `APPLE_DEVELOPER_ID` | `scripts/prebuild-sidecar.mjs` (`codesign --sign`) | **Full** name **with** prefix: `Developer ID Application: Anil Dukkipatty (9NM63KP2JC)`. |
  | `APPLE_ID` | notarize (afterSign hook) | Apple ID email |
  | `APPLE_APP_SPECIFIC_PASSWORD` | notarize | app-specific password from appleid.apple.com |
  | `APPLE_TEAM_ID` | notarize | 10-char team id (`9NM63KP2JC`) |

  Failure modes: if `CSC_NAME`/`APPLE_DEVELOPER_ID` are unset the app signs **ad-hoc**
  and notarization then fails at `checkSignatures`; if the `APPLE_*` trio is unset,
  `scripts/notarize.mjs` **skips** notarization. Both are release-blocking — verify
  §2 before publishing.
- **Publish tooling:** `doctl` authed, and `aws` configured for the DO Space
  (`--profile do-spaces`, S3-compatible). Space `revise-testing`, region `fra1`. Have
  the CDN endpoint id (`doctl compute cdn list` → `<CDN_ID>`).

---

## 1. Build (signed + notarized)

```bash
cd app
npm run dist          # loads .env.local → build (sidecar + renderer + main) → sign → notarize (afterSign)
```

On the **first** run, macOS prompts to use the signing key — click **Always Allow** (a
non-interactive shell would stall here). If it re-prompts or hangs, the login keychain
may be locked: `security unlock-keychain login.keychain`. Notarization then adds a few
minutes for the Apple round-trip.

Output in `app/release/` for both arches:

- `Ruby-X.Y.Z-arm64.dmg`, `Ruby-X.Y.Z.dmg` — hand-off downloads.
- `Ruby-X.Y.Z-arm64-mac.zip`, `Ruby-X.Y.Z-mac.zip` (+ `.blockmap`) — what
  Squirrel.Mac / `electron-updater` actually applies. **OTA references the `.zip`, not
  the dmg.**
- `latest-mac.yml` — the update manifest.

## 2. Verify the build

```bash
codesign --verify --deep --strict app/release/mac-arm64/Ruby.app && echo signed-ok
spctl -a -vvv -t install app/release/mac-arm64/Ruby.app     # expect: accepted, source=Notarized Developer ID
stapler validate app/release/mac-arm64/Ruby.app             # expect: The validate action worked
grep -E "^version:" app/release/latest-mac.yml              # must equal package.json / the tag
```

## 3. Publish to the DO Space + flush the CDN

Manifest is `no-cache`; the content-addressed payloads are immutable. Set the headers at
upload time (full commands in `RUBY_OTA_SPACES_CUTOVER.md` §1). From `app/release/`:

```bash
S3=s3://revise-testing/ruby/mac
AWS="aws --profile do-spaces --endpoint-url https://fra1.digitaloceanspaces.com"

$AWS s3 cp latest-mac.yml $S3/latest-mac.yml --acl public-read \
  --cache-control "no-cache" --content-type "text/yaml"
for f in *-mac.zip;  do $AWS s3 cp "$f" $S3/"$f" --acl public-read --cache-control "public, max-age=31536000, immutable" --content-type "application/zip"; done
for f in *.blockmap; do $AWS s3 cp "$f" $S3/"$f" --acl public-read --cache-control "public, max-age=31536000, immutable" --content-type "application/octet-stream"; done
for f in *.dmg;      do $AWS s3 cp "$f" $S3/"$f" --acl public-read --cache-control "public, max-age=31536000, immutable" --content-type "application/x-apple-diskimage"; done

# Manifest must not linger at the edge:
doctl compute cdn flush <CDN_ID> --files "ruby/mac/latest-mac.yml"
```

## 4. Verify the OTA feed + the update applying

```bash
curl -sS -D - -o /dev/null https://updates.codeongrass.com/ruby/mac/latest-mac.yml
#   expect HTTP 200, cache-control: no-cache, and the new version inside
curl -sS -D - -o /dev/null -r 0-1023 https://updates.codeongrass.com/ruby/mac/$(basename app/release/*-arm64-mac.zip)
#   expect HTTP 206 Partial Content (electron-updater uses range requests)
```

Then the real proof: launch a **prior-version** install and confirm it detects, downloads,
and applies the update (updater UX wired in `electron/updater.ts`, which also emits the
`update_available` / `update_downloaded` / `update_installed` analytics events).

---

## Push the release

Only after the feed + auto-update verify:

```bash
git push origin ruby-rebuild
git push origin vX.Y.Z
```

## Notes

- **Same signing identity across releases** — a recipient's microphone (TCC) grant is
  tied to the signature; reusing the identity preserves it.
- Notarized + stapled builds clear Gatekeeper with no `xattr` dance (unlike the old
  self-signed MVP flow).
- The `dmg` is only the manual hand-off; auto-update runs entirely off the `.zip` +
  `latest-mac.yml`.
- Rollback of a bad release = re-publish the previous `latest-mac.yml` (the old payload
  objects are immutable and still present) and flush the CDN. See
  `RUBY_OTA_SPACES_CUTOVER.md` § Rollback for the DNS-level fallback.
