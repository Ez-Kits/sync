import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("#app root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
