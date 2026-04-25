import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "BetterDB Playground - Valkey & Redis Chat",
  description:
    "An open-source RAG chatbot trained on Valkey and Redis OSS docs, demonstrating @betterdb/agent-cache and @betterdb/semantic-cache live.",
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
      </body>
    </html>
  );
}
