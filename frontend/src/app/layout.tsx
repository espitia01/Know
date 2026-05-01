import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { ClerkTokenProvider } from "@/components/ClerkTokenProvider";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/ThemeProvider";
import { BackgroundImageProvider } from "@/components/BackgroundImageProvider";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "katex/dist/katex.min.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
  style: ["normal", "italic"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Know",
  description: "Transform academic papers into interactive learning experiences",
  metadataBase: new URL("https://knowpaper.com"),
  // Spelling this out (rather than relying purely on Next.js' app-router
  // file-based icon conventions) is what makes Safari find the icon. Safari
  // specifically honours the `apple-touch-icon` link tag and ignores a
  // bare transparent `icon` file; pointing it at a sized PNG from /public
  // fixes the blank-tab rendering.
  icons: {
    icon: [
      { url: "/icon", type: "image/png", sizes: "512x512" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/apple-icon", type: "image/png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Know",
    description: "Transform academic papers into interactive learning experiences",
    type: "website",
    siteName: "Know",
    images: [{ url: "/apple-icon", width: 180, height: 180 }],
  },
  twitter: {
    card: "summary",
    title: "Know",
    description: "Transform academic papers into interactive learning experiences",
    images: ["/apple-icon"],
  },
};

// Dual theme-color: browsers that support `media` use the per-scheme value
// (Chrome/Edge/Safari on iOS). Others fall back to whatever the inline
// theme init script sets at runtime.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f0" },
    { media: "(prefers-color-scheme: dark)", color: "#16181f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
    >
      <html
        lang="en"
        className={`h-full scroll-smooth ${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
        suppressHydrationWarning
      >
        <head>
          {/*
            Inline theme script MUST run synchronously before first paint to
            avoid a white flash when a dark-mode user loads the page. Kept
            small and defensive — any throw would delay rendering.
          */}
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
          <meta name="theme-color" content="#fbfbfb" />
        </head>
        <body className="min-h-full flex flex-col antialiased">
          <ThemeProvider>
            <BackgroundImageProvider />
            <ClerkTokenProvider>{children}</ClerkTokenProvider>
          </ThemeProvider>
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
