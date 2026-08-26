import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: process.env.DOCENT_SERVER_URL || "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
