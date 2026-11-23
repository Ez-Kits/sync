import { mergeConfig } from "vite-plus";
import { definePackageConfig } from "../../vite.package";

export default mergeConfig(definePackageConfig({ entry: ["src/server.ts", "src/client.ts"] }), {
  // Provided by the Workers runtime.
  pack: { deps: { neverBundle: [/^cloudflare:/] } },
});
