import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { storage } from "./sync.ts";
import "./style.css";

async function bootstrap() {
  // Resolves once this tab owns the database or has reached the tab that does.
  await storage.ready;
  // await seedTodosOnce();

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("#app root not found");
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap().catch((error: unknown) => {
  console.error("Failed to initialize the local database", error);
  const root = document.querySelector<HTMLDivElement>("#app");
  if (root) {
    root.textContent =
      "Unable to open your local data. Your saved data was not replaced. Reload the app, and consult recovery instructions before clearing browser storage.";
  }
});
