import type { Metadata } from "next";

import { DashboardPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Overview — QuoteReady Studio",
};

export default function Page() {
  return <DashboardPage />;
}
