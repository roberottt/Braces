import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: ["es2021", "chrome105", "safari13"],
    minify: "esbuild",
    rollupOptions: { output: { manualChunks: undefined } },
  },
  clearScreen: false,
});
