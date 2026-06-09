#!/usr/bin/env node
// Block G3: afterSign hook invoked by electron-builder. Submits the signed
// .app bundle to Apple's notary service via @electron/notarize.
//
// Required env vars (skip with a warning if any are missing):
//   APPLE_ID                     - Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  - app-specific password from appleid.apple.com
//   APPLE_TEAM_ID                - 10-char team ID
//
// electron-builder calls this script with a context object: { appOutDir,
// packager, electronPlatformName, ... }.

export default async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn(
      "[notarize] skipping notarization (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID unset)",
    );
    return;
  }

  // Lazy import so this script doesn't fail when the optional dep is absent
  // on dev machines that never run `npm run dist`.
  let notarize;
  try {
    ({ notarize } = await import("@electron/notarize"));
  } catch (err) {
    console.warn(
      `[notarize] @electron/notarize not installed (${err.message}) — run \`npm i -D @electron/notarize\` before \`npm run dist\``,
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appPath} to Apple notary service…`);
  await notarize({
    tool: "notarytool",
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log("[notarize] notarization complete");
}
