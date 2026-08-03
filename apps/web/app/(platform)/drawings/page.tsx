import type { Metadata } from "next";

import { DrawingsPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Drawings — QuoteReady Studio",
};

export default function Page() {
  return <DrawingsPage />;
}
