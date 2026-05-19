import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getOpenWAConfig() {
  const rows = await prisma.setting.findMany({
    where: {
      key: { in: ["openwa_api_url", "openwa_api_key"] },
    },
  });
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    apiUrl: map.openwa_api_url || "",
    apiKey: map.openwa_api_key || "",
  };
}

async function proxyRequest(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const user = getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { apiUrl, apiKey } = await getOpenWAConfig();
  if (!apiUrl) {
    return NextResponse.json(
      { error: "OpenWA API URL not configured. Go to Settings → OpenWA to set it up." },
      { status: 503 }
    );
  }

  const { path } = await params;
  const pathStr = path.join("/");
  const url = new URL(pathStr, apiUrl.endsWith("/") ? apiUrl : apiUrl + "/");
  const searchParams = req.nextUrl.searchParams;
  searchParams.forEach((value, key) => url.searchParams.set(key, value));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  try {
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await req.text();
      } catch {
        // no body
      }
    }

    const response = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: body || undefined,
    });

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    const blob = await response.blob();
    return new NextResponse(blob, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OpenWA proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const DELETE = proxyRequest;
export const PATCH = proxyRequest;
