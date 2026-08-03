import type { Metadata } from "next";

import { PlannerPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "New plan — QuoteReady Studio",
};

export default function Page() {
  return <PlannerPage />;
}
