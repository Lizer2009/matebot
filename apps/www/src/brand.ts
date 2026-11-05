export const BRAND_KIT_PATH = "/brand/";
export const WORDMARK_SVG_PATH = "/brand/kit/matebot-wordmark.svg";

export const BRAND_LOGOS = [
  {
    name: "Logo",
    file: "/brand/kit/matebot-logo.png",
    preview: "/brand/kit/matebot-logo-preview.webp",
    format: "PNG · 1024 × 1024",
  },
  {
    name: "Wordmark",
    file: WORDMARK_SVG_PATH,
    preview: WORDMARK_SVG_PATH,
    format: "SVG",
  },
  {
    name: "App icon",
    file: "/brand/kit/matebot-icon.png",
    preview: "/brand/kit/matebot-icon-preview.webp",
    format: "PNG · 1024 × 1024",
  },
] as const;

/** The two mark colors; the product UI itself stays on `@matebot/ui-tokens`. */
export const BRAND_COLORS = [
  { name: "Indigo", hex: "#312E81" },
  { name: "Teal", hex: "#0D9488" },
] as const;
