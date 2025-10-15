// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

import vercel from "@astrojs/vercel";

import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
    adapter: cloudflare(),
    integrations: [sitemap()],
});