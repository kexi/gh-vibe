import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://gh-vibe.kexi.dev",
  integrations: [
    starlight({
      title: "gh-vibe",
      components: {
        SocialIcons: "./src/components/CustomSocialIcons.astro",
      },
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        ja: {
          label: "日本語",
          lang: "ja",
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kexi/gh-vibe",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/kexi/gh-vibe/edit/main/packages/docs/src/content/docs/",
      },
      sidebar: [
        {
          label: "Introduction",
          translations: { ja: "はじめに" },
          items: [
            {
              slug: "index",
              label: "Welcome",
              translations: { ja: "ようこそ" },
            },
            {
              slug: "getting-started",
              label: "Getting Started",
              translations: { ja: "クイックスタート" },
            },
          ],
        },
        {
          label: "Installation",
          translations: { ja: "インストール" },
          items: [
            {
              slug: "installation",
              label: "Installation",
              translations: { ja: "インストール" },
            },
          ],
        },
        {
          label: "Commands",
          translations: { ja: "コマンド" },
          autogenerate: { directory: "commands" },
        },
        {
          slug: "development",
          label: "Development",
          translations: { ja: "開発" },
        },
        {
          slug: "changelog",
          label: "Changelog",
          translations: { ja: "変更履歴" },
        },
      ],
    }),
  ],
});
