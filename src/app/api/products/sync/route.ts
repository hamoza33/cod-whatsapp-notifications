import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { syncProductsFromCodNetwork } from "@/lib/product-sync";
import { CodNetworkApiError } from "@/lib/cod-network";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncProductsFromCodNetwork();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof CodNetworkApiError) {
      return NextResponse.json(
        { error: err.message, status: err.status, body: err.body },
        { status: 502 }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
