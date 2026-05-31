import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";

function copyManifest(): Plugin {
  return {
    name: "copy-manifest",
    closeBundle() {
      mkdirSync("dist", { recursive: true });
      copyFileSync(
        resolve(__dirname, "src/manifest.json"),
        resolve(__dirname, "dist/manifest.json"),
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const isPageHook = mode === "page-hook";

  return {
    build: {
      lib: {
        entry: resolve(__dirname, isPageHook ? "src/page-hook.ts" : "src/content.ts"),
        name: isPageHook ? "SFPageHook" : "SFContent",
        formats: ["iife"],
        fileName: () => (isPageHook ? "page-hook.js" : "content.js"),
      },
      outDir: "dist",
      emptyOutDir: !isPageHook,
    },
    plugins: isPageHook ? [] : [copyManifest()],
  };
});
