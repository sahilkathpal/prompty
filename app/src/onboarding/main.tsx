import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary, installRendererErrorHandlers } from "../shared/error-reporting";
import "../shared/tokens.css";
import "./onboarding.css";

installRendererErrorHandlers("onboarding");
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <ErrorBoundary surface="onboarding">
    <App />
  </ErrorBoundary>,
);
