import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform-shell";
import { readZooSession } from "@/lib/zoo-auth";

export const dynamic = "force-dynamic";

export default async function PlatformLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await readZooSession().catch(() => null);
  if (!session) redirect("/login");
  return <PlatformShell>{children}</PlatformShell>;
}
