import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import { ClerkTokenProvider } from "@/components/ClerkTokenProvider";
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

export const metadata: Metadata = {
  title: "Know",
  description: "Transform academic papers into interactive learning experiences",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "180x180" },
    ],
    apple: "/apple-icon.png",
  },
  metadataBase: new URL("https://knowpaper.com"),
  openGraph: {
    title: "Know",
    description: "Transform academic papers into interactive learning experiences",
    type: "website",
    siteName: "Know",
  },
  twitter: {
    card: "summary",
    title: "Know",
    description: "Transform academic papers into interactive learning experiences",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/" signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/dashboard" signUpFallbackRedirectUrl="/dashboard">
      <html lang="en" className={`h-full scroll-smooth ${inter.variable} ${sourceSerif.variable}`}>
        <head>
          <meta name="theme-color" content="#f8f7ff" />
        </head>
        <body className="min-h-full flex flex-col antialiased">
          <ClerkTokenProvider>{children}</ClerkTokenProvider>
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
