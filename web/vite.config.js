import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on KILL_SWITCH_PORT (default 6550) and Vite on VITE_PORT (default 6560); /api is proxied.
const api = { target: `http://127.0.0.1:${Number(process.env.KILL_SWITCH_PORT) || 6550}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 6560, strictPort: true, proxy: { "/api": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
