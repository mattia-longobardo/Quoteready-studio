import type { Metadata } from "next";

import { ReportsPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Reports — QuoteReady Studio",
};

export default function Page() {
  return <ReportsPage />;
}
