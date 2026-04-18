import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { ClerkTokenProvider } from "@/components/ClerkTokenProvider";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "katex/dist/katex.min.css";

export const metadata: Metadata = {
  title: "Know",
  description: "Transform academic papers into interactive learning experiences",
  icons: {
    icon: "/favicon.png",
    apple: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/" signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/dashboard" signUpFallbackRedirectUrl="/dashboard">
      <html lang="en" className="h-full scroll-smooth">
        <head>
          <meta name="theme-color" content="#ffffff" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;0,8..60,700;1,8..60,400;1,8..60,500&display=swap"
            rel="stylesheet"
          />
        </head>
        <body className="min-h-full flex flex-col antialiased">
          <ClerkTokenProvider>{children}</ClerkTokenProvider>
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
