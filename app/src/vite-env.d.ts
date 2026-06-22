/// <reference types="vite/client" />

// Minimal ambient typing for the Vite-injected `import.meta.env` used in the
// renderer. Vite statically replaces `import.meta.env.DEV` at build time
// (production build → false), which we use to gate dev-only UI (e.g. the raw
// call-log dump on legacy post-call cards).
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
