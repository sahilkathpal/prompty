import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary, installRendererErrorHandlers } from "../shared/error-reporting";
import { installAudioRouteListener } from "../shared/audio-route";
import "./overlay.css";

installRendererErrorHandlers("overlay");
// The overlay renderer is alive for the whole app lifetime, so it's the reliable
// home for the always-on audio device-change watcher.
installAudioRouteListener();
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <ErrorBoundary surface="overlay">
    <App />
  </ErrorBoundary>,
);
