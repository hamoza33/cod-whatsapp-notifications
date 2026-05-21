import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { parseCsvBuffer, parseXlsxBuffer } from "@/lib/bulk-messaging/parser";

export const runtime = "nodejs";
// Allow up to ~10MB uploads — well above any realistic recipient sheet but
// small enough that a runaway file doesn't consume the worker for minutes.
export const maxDuration = 60;

/**
 * Multipart upload endpoint. Accepts a single `file` field with a CSV or
 * XLSX recipient sheet and returns the parsed columns + rows. The client
 * keeps the parsed rows in memory and posts them back when creating a
 * campaign, so this endpoint is stateless — no temp storage on the server.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a `file` field." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "`file` field is required and must be a file." },
      { status: 400 }
    );
  }

  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "File is larger than 10 MB. Please split your sheet." },
      { status: 413 }
    );
  }

  const name = file.name.toLowerCase();
  const bytes = await file.arrayBuffer();
  try {
    if (name.endsWith(".xlsx") || file.type.includes("spreadsheetml")) {
      const parsed = await parseXlsxBuffer(bytes);
      return NextResponse.json(parsed);
    }
    if (name.endsWith(".csv") || file.type.includes("csv") || file.type === "text/plain") {
      const parsed = parseCsvBuffer(bytes);
      return NextResponse.json(parsed);
    }
    return NextResponse.json(
      {
        error:
          "Unsupported file type. Upload a CSV (.csv) or Excel (.xlsx) file.",
      },
      { status: 415 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to parse file";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
