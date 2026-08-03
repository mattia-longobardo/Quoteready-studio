import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { toSummary } from "@/lib/documents";
import { getWorkspace } from "@/lib/platform-store";
import { publicSettings } from "@/lib/user-settings";

export const runtime = "nodejs";

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const workspace = await getWorkspace(session.user.id);
  return NextResponse.json({
    folders: workspace.folders,
    machines: workspace.machines,
    reports: workspace.reports,
    documents: workspace.documents.map(toSummary),
    parts: workspace.parts,
    drawings: workspace.drawings,
    settings: publicSettings(workspace.settings),
    stats: {
      reports: workspace.reports.filter((item) => !item.trashedAt).length,
      ready: workspace.reports.filter(
        (item) => !item.trashedAt && item.report.status === "ready",
      ).length,
      machines: workspace.machines.filter((item) => item.enabled).length,
      documents: workspace.documents.filter((item) => !item.trashedAt).length,
    },
  });
}
