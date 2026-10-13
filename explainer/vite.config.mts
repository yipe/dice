import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One script, site/app.js, next to the hand-written site/index.html and its fonts. Everything in site/ is the
// deployed page; app.js is the only generated file (and is gitignored).
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: "site",
    emptyOutDir: false,
    lib: { entry: "web/main.tsx", formats: ["iife"], name: "DiceExplainer", fileName: () => "app.js" },
  },
  preview: { open: false },
});
