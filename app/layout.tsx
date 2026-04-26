import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

/**
 * Self-hosted via next/font (no runtime requests to Google Fonts). Exposed
 * as CSS variables so globals.css can reference them via --font-sans /
 * --font-mono regardless of which family is bound here.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * `metadataBase` makes every relative URL in `openGraph.images`,
 * `twitter.images`, etc. resolve to absolute URLs (Open Graph and Twitter
 * cards both reject relative paths). Override via `NEXT_PUBLIC_SITE_URL`
 * on Vercel preview deploys so previews don't get production OG cards.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://chat.betterdb.com";

const TITLE = "BetterDB Playground - RESP-compatible DBs and BetterDB";
const DESCRIPTION =
  "Open-source RAG chatbot over Valkey, Redis OSS, Dragonfly, and BetterDB " +
  "docs. Live demo of @betterdb/agent-cache and @betterdb/semantic-cache " +
  "with real-time hit/miss metrics.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // Image at app/opengraph-image.png is auto-detected by Next.js and emitted
  // as <meta property="og:image">. We only need to declare the textual OG
  // fields here; the image binding is by file convention.
  openGraph: {
    type: "website",
    title: TITLE,
    description: DESCRIPTION,
    siteName: "BetterDB Playground",
    url: SITE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    // No `images` field: Twitter clients fall back to og:image, which Next
    // wires automatically from app/opengraph-image.png. One image file,
    // both networks served.
  },
};

// Inline script that runs before paint to prevent a flash of the wrong theme.
const themeScript = `
  (function() {
    try {
      var stored = localStorage.getItem('theme');
      var theme = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
      var resolved = theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
      if (resolved === 'dark') document.documentElement.classList.add('dark');
    } catch (e) {}
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-background text-foreground font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
