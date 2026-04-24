import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { ClerkTokenProvider } from "@/components/ClerkTokenProvider";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/ThemeProvider";
import { BackgroundImageProvider } from "@/components/BackgroundImageProvider";
import { BG_INIT_SCRIPT } from "@/lib/backgroundImage";
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
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: ["/favicon.ico"],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Know",
    description: "Transform academic papers into interactive learning experiences",
    type: "website",
    siteName: "Know",
    images: [{ url: "/apple-touch-icon.png", width: 180, height: 180 }],
  },
  twitter: {
    card: "summary",
    title: "Know",
    description: "Transform academic papers into interactive learning experiences",
    images: ["/apple-touch-icon.png"],
  },
};

// Dual theme-color: browsers that support `media` use the per-scheme value
// (Chrome/Edge/Safari on iOS). Others fall back to whatever the inline
// theme init script sets at runtime.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfb" },
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
          {/* Hydrate the custom background CSS vars before first paint
             so Scholar+ users never see a flash of the default
             surface while React mounts the provider. */}
          <script dangerouslySetInnerHTML={{ __html: BG_INIT_SCRIPT }} />
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
