import type { Metadata } from "next";

import { PartsPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Parts — QuoteReady Studio",
};

export default function Page() {
  return <PartsPage />;
}
