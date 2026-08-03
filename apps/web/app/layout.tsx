import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "QuoteReady Studio — Manufacturing intelligence",
  description:
    "Turn CAD into factory-aware manufacturing routes, validated estimates and quote-ready reports with Zoo APIs.",
};

// Applied before hydration so the page never flashes the wrong theme. The
// stored value is the user preference; "system" (or none) follows the device.
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("qr-theme");var l=window.matchMedia("(prefers-color-scheme: light)").matches;document.documentElement.dataset.theme=(p==="light"||p==="dark")?p:(l?"light":"dark");}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
