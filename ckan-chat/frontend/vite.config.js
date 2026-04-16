import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/chatbot/",
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:3001",
        changeOrigin: true,
      },
      "/analytics-api": {
        target: process.env.VITE_ANALYTICS_URL || "http://localhost:3004",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/analytics-api/, ""),
      },
    },
  },
});
