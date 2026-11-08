import { definePackageConfig } from "../../vite.package";

export default definePackageConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts", pg: "src/pg/index.ts" },
});
