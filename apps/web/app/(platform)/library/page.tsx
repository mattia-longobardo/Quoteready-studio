import type { Metadata } from "next";

import { LibraryPage } from "@/components/platform-pages";

export const metadata: Metadata = {
  title: "Zoo library — QuoteReady Studio",
};

export default function Page() {
  return <LibraryPage />;
}
