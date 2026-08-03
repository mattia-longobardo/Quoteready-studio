import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { isMachineProcess } from "@quoteredy/core/manufacturing";
import { isMaterialId } from "@quoteredy/core/materials";
import {
  deleteMachine,
  getWorkspace,
  StoreQuotaError,
  upsertMachine,
} from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  readJsonObject,
  RequestInputError,
} from "@/lib/request-security";

export const runtime = "nodejs";

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RequestInputError(
      `${label} must be between ${minimum} and ${maximum}.`,
    );
  }
  return number;
}

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  return NextResponse.json((await getWorkspace(session.user.id)).machines);
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    enforceRateLimit(`factory:${session.user.id}`, 30, 60_000);
    const body = await readJsonObject(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const process = typeof body.process === "string" ? body.process.trim() : "";
    if (!name || name.length > 100) {
      throw new RequestInputError(
        "Machine name is required and cannot exceed 100 characters.",
      );
    }
    if (!isMachineProcess(process)) {
      throw new RequestInputError("Select a supported factory capability.");
    }
    const materials = Array.isArray(body.materials)
      ? body.materials.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (
      materials.length > 20 ||
      materials.some(
        (material) => !isMaterialId(material) || material === "unknown",
      )
    ) {
      throw new RequestInputError(
        "Machine materials must use the supported material catalogue.",
      );
    }
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (notes.length > 500)
      throw new RequestInputError(
        "Machine notes cannot exceed 500 characters.",
      );

    const machine = await upsertMachine(session.user.id, {
      id:
        typeof body.id === "string" && body.id.length <= 64
          ? body.id
          : undefined,
      name,
      process,
      hourlyRate: boundedNumber(body.hourlyRate, "Hourly rate", 0, 10_000),
      setupMinutes: boundedNumber(
        body.setupMinutes ?? 0,
        "Setup time",
        0,
        10_080,
      ),
      materials: [...new Set(materials)],
      enabled: body.enabled !== false,
      notes,
    });
    return NextResponse.json(machine, { status: 201 });
  } catch (error) {
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(
      error,
      "The factory capability could not be saved.",
    );
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    enforceRateLimit(`factory:${session.user.id}`, 30, 60_000);
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id || id.length > 64)
      throw new RequestInputError("A valid machine ID is required.");
    return NextResponse.json({
      deleted: await deleteMachine(session.user.id, id),
    });
  } catch (error) {
    return inputErrorResponse(error, "The machine could not be removed.");
  }
}
