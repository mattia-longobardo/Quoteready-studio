import type { Metadata } from "next";

import { FactoryPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "My factory — QuoteReady Studio",
};

export default function Page() {
  return <FactoryPage />;
}
