import react from "@astrojs/react";
import { satteri } from "@astrojs/markdown-satteri";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { isIndexedPath } from "./src/blog/indexability.ts";
import { docsCallouts } from "./src/docs-callouts.ts";
import { HOME_LOCALE, LOCALE_HREFLANG, LOCALES } from "./src/i18n/locales.ts";
import { marketingOrigin } from "./src/origins.ts";
import { resolveWwwPort } from "./www-port.mjs";

const wwwPort = resolveWwwPort();

export default defineConfig({
  site: marketingOrigin(process.env),
  output: "static",
  i18n: {
    // The homepage language is unprefixed, so it is also the routing default; other locales keep
    // their prefix. `DEFAULT_LOCALE` stays the content language of docs and other English pages.
    defaultLocale: HOME_LOCALE,
    locales: [...LOCALES],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    react(),
    sitemap({
      filter: (page) => isIndexedPath(new URL(page).pathname),
      i18n: {
        defaultLocale: HOME_LOCALE,
        locales: LOCALE_HREFLANG,
      },
    }),
  ],
  markdown: {
    processor: satteri({ hastPlugins: [docsCallouts] }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    host: "127.0.0.1",
    port: wwwPort,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: wwwPort,
  },
});
