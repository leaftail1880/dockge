import vue from "@vitejs/plugin-vue";
import { BootstrapVueNextResolver } from "unplugin-vue-components/resolvers";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";
import viteCompression from "vite-plugin-compression";
import "vue";

const viteCompressionFilter = /\.(js|mjs|json|css|html|svg)$/i;

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 5000,
  },
  define: {
    FRONTEND_VERSION: JSON.stringify(process.env.npm_package_version),
  },
  root: "./frontend",
  build: {
    outDir: "../frontend-dist",
  },
  plugins: [
    vue(),
    Components({
      dirs: ["src/components", "src/pages", "src/layouts"],
      dts: "components.d.ts",
      resolvers: [BootstrapVueNextResolver()],
    }),
    viteCompression({
      algorithm: "gzip",
      filter: viteCompressionFilter,
    }),
    viteCompression({
      algorithm: "brotliCompress",
      filter: viteCompressionFilter,
    }),
  ],
});
