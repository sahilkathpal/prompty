import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary, installRendererErrorHandlers } from "../shared/error-reporting";
import "./overlay.css";

installRendererErrorHandlers("overlay");
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <ErrorBoundary surface="overlay">
    <App />
  </ErrorBoundary>,
);
