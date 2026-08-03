import Busboy from "busboy";
import type { IncomingHttpHeaders } from "node:http";

import { RequestInputError } from "@/lib/request-security";

const MAX_CAD_BYTES = 20 * 1024 * 1024;
const MAX_DRAWING_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = 32 * 1024 * 1024;

export interface UploadedFile {
  name: string;
  mediaType: string;
  size: number;
  bytes: Buffer;
}

interface AnalysisMultipart {
  fields: Record<string, string>;
  cadFile: UploadedFile | null;
  drawing: UploadedFile | null;
}

export async function parseAnalysisMultipart(
  request: Request,
): Promise<AnalysisMultipart> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new RequestInputError(
      "Content-Type must be multipart/form-data.",
      415,
    );
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestInputError(
        "The request has an invalid Content-Length header.",
      );
    }
    if (length > MAX_MULTIPART_BYTES) {
      throw new RequestInputError(
        "The RFQ package exceeds the 32 MB upload limit.",
        413,
      );
    }
  }
  if (!request.body)
    throw new RequestInputError("The multipart request body is empty.");

  return await new Promise<AnalysisMultipart>((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: {
      cadFile: UploadedFile | null;
      drawing: UploadedFile | null;
    } = {
      cadFile: null,
      drawing: null,
    };
    let totalBytes = 0;
    let completed = false;

    const finishWithError = (error: Error) => {
      if (completed) return;
      completed = true;
      reject(error);
    };

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: Object.fromEntries(request.headers) as IncomingHttpHeaders,
        limits: {
          files: 2,
          fields: 12,
          parts: 14,
          fieldNameSize: 64,
          fieldSize: 4 * 1024,
          fileSize: MAX_CAD_BYTES,
        },
      });
    } catch {
      reject(new RequestInputError("The multipart boundary is invalid."));
      return;
    }

    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        finishWithError(
          new RequestInputError(
            `The ${name} field exceeds its size limit.`,
            413,
          ),
        );
        return;
      }
      if (Object.hasOwn(fields, name)) {
        finishWithError(
          new RequestInputError(
            `The ${name} field was supplied more than once.`,
          ),
        );
        return;
      }
      fields[name] = value;
    });

    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "cadFile" && fieldName !== "drawing") {
        stream.resume();
        finishWithError(
          new RequestInputError(`Unexpected file field: ${fieldName}.`),
        );
        return;
      }
      if (files[fieldName]) {
        stream.resume();
        finishWithError(
          new RequestInputError(
            `The ${fieldName} file was supplied more than once.`,
          ),
        );
        return;
      }

      const maximum =
        fieldName === "cadFile" ? MAX_CAD_BYTES : MAX_DRAWING_BYTES;
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      stream.on("data", (chunk: Buffer) => {
        fileBytes += chunk.byteLength;
        if (fileBytes > maximum) {
          finishWithError(
            new RequestInputError(
              fieldName === "cadFile"
                ? "The CAD file exceeds the 20 MB limit."
                : "The supporting drawing exceeds the 10 MB limit.",
              413,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("limit", () => {
        finishWithError(
          new RequestInputError(
            "An uploaded file exceeds its size limit.",
            413,
          ),
        );
      });
      stream.on("end", () => {
        if (completed || fileBytes === 0) return;
        files[fieldName] = {
          name: info.filename.slice(0, 255),
          mediaType: info.mimeType.slice(0, 120),
          size: fileBytes,
          bytes: Buffer.concat(chunks, fileBytes),
        };
      });
    });

    parser.on("filesLimit", () =>
      finishWithError(new RequestInputError("Too many files were uploaded.")),
    );
    parser.on("fieldsLimit", () =>
      finishWithError(
        new RequestInputError("Too many form fields were supplied."),
      ),
    );
    parser.on("partsLimit", () =>
      finishWithError(
        new RequestInputError("The multipart request has too many parts."),
      ),
    );
    parser.on("error", () =>
      finishWithError(
        new RequestInputError("The multipart request is invalid."),
      ),
    );
    parser.on("finish", () => {
      if (completed) return;
      completed = true;
      resolve({ fields, ...files });
    });

    void (async () => {
      const reader = request.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_MULTIPART_BYTES) {
            await reader.cancel("multipart body limit exceeded");
            finishWithError(
              new RequestInputError(
                "The RFQ package exceeds the 32 MB upload limit.",
                413,
              ),
            );
            return;
          }
          if (!parser.write(Buffer.from(value))) {
            await new Promise<void>((resume) => parser.once("drain", resume));
          }
          if (completed) {
            await reader.cancel("multipart parser stopped");
            return;
          }
        }
        parser.end();
      } catch {
        finishWithError(
          new RequestInputError("The upload stream could not be read."),
        );
      } finally {
        reader.releaseLock();
      }
    })();
  });
}
