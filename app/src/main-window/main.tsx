import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../shared/tokens.css";
import "./main-window.css";
import "./prep.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
