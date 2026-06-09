// Minimal fake for the `electron` module so coach-session can be exercised
// outside of an Electron runtime in smoke tests.
class Notification {
  constructor(opts) { this.opts = opts; }
  on() {}
  show() {}
  static isSupported() { return false; }
}
const shell = {
  showItemInFolder() {},
  openExternal() {},
};
const app = {
  isPackaged: false,
  getPath: (k) => {
    if (k === "userData") return require("node:os").tmpdir();
    return require("node:os").tmpdir();
  },
};
module.exports = { Notification, shell, app };
