import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { config } from "dotenv";

// Load environment variables from .env file
config();

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    // Define environment variables at build time
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
