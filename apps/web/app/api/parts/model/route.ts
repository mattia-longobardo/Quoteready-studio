import { NextResponse } from "next/server";

import { getBlobStore } from "@quoteredy/storage";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { getWorkspace } from "@/lib/platform-store";
import { GLTF_CONTENT_TYPE } from "@/lib/zoo-model";

export const runtime = "nodejs";

/** Serve a part's stored glTF preview model to the authenticated owner. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id || id.length > 64) {
    return NextResponse.json(
      { error: "A valid part ID is required." },
      { status: 400 },
    );
  }
  const workspace = await getWorkspace(session.user.id);
  const part = workspace.parts.find((item) => item.id === id);
  if (!part?.modelBlobKey) {
    return NextResponse.json(
      { error: "No preview model is stored for this part." },
      { status: 404 },
    );
  }
  const bytes = await getBlobStore().get(part.modelBlobKey);
  if (!bytes) {
    return NextResponse.json(
      { error: "The preview model is no longer available." },
      { status: 404 },
    );
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": GLTF_CONTENT_TYPE,
      "Content-Disposition": 'inline; filename="model.gltf"',
      "Cache-Control": "private, max-age=3600",
    },
  });
}
