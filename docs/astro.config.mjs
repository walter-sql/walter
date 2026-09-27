import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { shikiThemes } from "./src/shiki.mjs";

export default defineConfig({
  site: "https://walter.ax",
  redirects: {
    "/docs/how-it-fits/": "/docs/your-app/",
    "/docs/connect-postgres/": "/docs/installation/"
  },
  devToolbar: { enabled: false },
  server: { port: 4321 },
  vite: { server: { allowedHosts: true, strictPort: true } },
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { themes: shikiThemes, defaultColor: false }
  }
});
