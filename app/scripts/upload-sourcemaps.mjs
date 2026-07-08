// Inject PostHog chunk IDs into the built renderer bundle and upload its source
// maps, so field crashes — which are always minified for remote users — arrive
// in PostHog with original source (RUBY_OBSERVABILITY_PLAN §8).
//
// Runs in the RELEASE path (`npm run dist`) after `npm run build` and before
// electron-builder packages the app. The injected chunk-ID comments stay in the
// shipped JS; the .map files are uploaded to PostHog and then excluded from the
// asar by electron-builder (`!**/*.map`), so maps live in PostHog only.
//
// Credentials (personal API key + project id) come from the environment, loaded
// by `npm run dist` from app/.env.local alongside the signing/notary secrets:
//   POSTHOG_CLI_API_KEY   – a PostHog personal API key with error-tracking write
//   POSTHOG_CLI_PROJECT_ID – the numeric project id (ruby = 481524)
//   POSTHOG_CLI_HOST       – optional; defaults to https://us.posthog.com
//
// Without credentials it runs the CLI in --dry-run (validates the bundle, no
// upload, no inject) and exits 0 — so a plain `npm run build` or a CI gate that
// lacks secrets never fails, it just ships un-symbolicated (minified) stacks.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dir = resolve(root, "dist/renderer");

const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const host = process.env.POSTHOG_CLI_HOST || "https://us.posthog.com";
const haveCreds = !!(process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID);

// Pin the CLI version so releases are reproducible.
const CLI = "@posthog/cli@0.8.1";

const args = ["--yes", CLI, "--host", host];
if (!haveCreds) {
  console.warn(
    "[sourcemaps] POSTHOG_CLI_API_KEY / POSTHOG_CLI_PROJECT_ID not set — running --dry-run; " +
      "this build's renderer stacks will NOT symbolicate in PostHog.",
  );
  args.push("--dry-run");
}
// `process` = inject chunk IDs then upload, tagged with this release so PostHog
// can group crash-free-rate by version.
args.push(
  "sourcemap",
  "process",
  "--directory",
  dir,
  "--release-name",
  "ruby",
  "--release-version",
  version,
);

console.log(`[sourcemaps] ${haveCreds ? "uploading" : "dry-run"} renderer maps for ruby@${version} → ${host}`);
const res = spawnSync("npx", args, { stdio: "inherit", cwd: root });
if (res.status !== 0) {
  console.error(`[sourcemaps] posthog-cli exited ${res.status}`);
  process.exit(res.status ?? 1);
}
