import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import ExcelJS from "exceljs";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const carrier = searchParams.get("carrier");
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const where: Record<string, unknown> = {};
  if (carrier) where.carrier = carrier;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { trackingNumber: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
    ];
  }
  if (dateFrom || dateTo) {
    const dateFilter: Record<string, Date> = {};
    if (dateFrom) dateFilter.gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      dateFilter.lte = to;
    }
    where.codCreatedAt = dateFilter;
  }

  const orders = await prisma.trackingOrder.findMany({
    where,
    include: {
      events: { orderBy: { occurredAt: "desc" }, take: 1 },
      order: {
        select: {
          codNetworkOrderId: true,
          productName: true,
          customerCity: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Package Tracking");

  sheet.columns = [
    { header: "Tracking Number", key: "trackingNumber", width: 22 },
    { header: "Carrier", key: "carrier", width: 16 },
    { header: "Status", key: "status", width: 18 },
    { header: "Customer Name", key: "customerName", width: 22 },
    { header: "Customer Phone", key: "customerPhone", width: 18 },
    { header: "Product", key: "productName", width: 28 },
    { header: "City", key: "city", width: 18 },
    { header: "Latest Event", key: "latestEvent", width: 35 },
    { header: "Latest Event Date", key: "latestEventAt", width: 20 },
    { header: "COD Created Date", key: "codCreatedAt", width: 20 },
    { header: "Last Checked", key: "lastCheckedAt", width: 20 },
    { header: "COD Order ID", key: "codOrderId", width: 15 },
  ];

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2563EB" },
  };

  const STATUS_LABELS: Record<string, string> = {
    PENDING: "Pending",
    IN_TRANSIT: "In Transit",
    OUT_FOR_DELIVERY: "Out for Delivery",
    DELIVERED: "Delivered",
    RETURNED: "Returned",
    EXCEPTION: "Exception",
    UNKNOWN: "Unknown",
  };

  for (const order of orders) {
    sheet.addRow({
      trackingNumber: order.trackingNumber,
      carrier: order.carrierName || order.carrier,
      status: STATUS_LABELS[order.status] || order.status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      productName: order.productName || order.order?.productName,
      city: order.order?.customerCity,
      latestEvent: order.latestEvent,
      latestEventAt: order.latestEventAt
        ? new Date(order.latestEventAt).toLocaleString()
        : "",
      codCreatedAt: order.codCreatedAt
        ? new Date(order.codCreatedAt).toLocaleDateString()
        : "",
      lastCheckedAt: order.lastCheckedAt
        ? new Date(order.lastCheckedAt).toLocaleString()
        : "",
      codOrderId: order.order?.codNetworkOrderId,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="package-tracking-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
