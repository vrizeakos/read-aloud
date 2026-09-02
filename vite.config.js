import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes the build work at any GitHub Pages path
// (https://user.github.io/repo-name/) without editing this file.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "esnext" },
  optimizeDeps: { exclude: ["kokoro-js", "@huggingface/transformers"] },
});
