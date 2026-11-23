import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loadConfig } from "./src/config.ts";

const { port } = loadConfig();

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:8787" }, // default SW_PORT
  },
  build: { outDir: "dist" },
});
