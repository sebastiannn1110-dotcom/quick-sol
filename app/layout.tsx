import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: {
    default: "Electronic Parts Demo",
    template: "%s | Electronic Parts Demo"
  },
  applicationName: "Electronic Parts Demo",
  description: "B2B platform for electronic component sourcing, inventory intelligence, RFQs, customers and commercial operations.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }]
  },
  openGraph: {
    type: "website",
    title: "Electronic Parts Demo",
    siteName: "Electronic Parts Demo",
    description: "B2B platform for electronic component sourcing, inventory intelligence, RFQs, customers and commercial operations."
  },
  twitter: {
    card: "summary",
    title: "Electronic Parts Demo",
    description: "B2B platform for electronic component sourcing, inventory intelligence, RFQs, customers and commercial operations."
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
