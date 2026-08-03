import type { Metadata } from "next";

import { ResultsPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Results — QuoteReady Studio",
};

export default function Page() {
  return <ResultsPage />;
}
