import type { Metadata } from "next";

import { SettingsPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Settings — QuoteReady Studio",
};

export default function Page() {
  return <SettingsPage />;
}
