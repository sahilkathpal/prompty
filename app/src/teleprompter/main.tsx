import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./teleprompter.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
