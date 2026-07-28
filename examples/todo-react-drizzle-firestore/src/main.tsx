import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { migrateLocalSchema } from "./db/index.ts";
import "./style.css";

async function bootstrap() {
  await migrateLocalSchema();
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

void bootstrap();
