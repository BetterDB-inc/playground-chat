import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BetterDB Playground — Valkey & Redis Chat",
  description:
    "A public RAG chatbot trained on Valkey and Redis OSS docs, demonstrating agent-cache and semantic-cache live.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0f1923] text-slate-200 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
