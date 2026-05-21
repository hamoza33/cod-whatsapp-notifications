"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  MessageSquare,
  Settings,
  RefreshCw,
  LogOut,
  Send,
  Columns3,
  Inbox,
  Zap,
  FileText,
  ShoppingBag,
  Truck,
  Megaphone,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useRouter } from "next/navigation";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/pipeline", label: "Pipeline", icon: Columns3 },
  { href: "/products", label: "Products", icon: ShoppingBag },
  { href: "/inbox", label: "WhatsApp Inbox", icon: Inbox },
  { href: "/bulk-messaging", label: "Bulk Messaging", icon: Megaphone },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/tracking", label: "Package Tracking", icon: Truck },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/messages", label: "Message Logs", icon: MessageSquare },
  { href: "/sync-logs", label: "Sync Logs", icon: RefreshCw },
  { href: "/test-message", label: "Test Message", icon: Send },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    await api.post("/auth/logout");
    router.push("/login");
  };

  return (
    <aside className="w-64 bg-gradient-to-b from-gray-900 via-gray-900 to-gray-950 text-white flex flex-col min-h-screen shadow-xl">
      <div className="px-5 py-5 border-b border-gray-800/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center shadow-lg shadow-green-500/20">
            <Send size={16} className="text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">COD WhatsApp</h1>
            <p className="text-[11px] text-gray-400 leading-none mt-0.5">
              Delivery Notifications
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                isActive
                  ? "bg-blue-600/90 text-white shadow-md shadow-blue-500/20"
                  : "text-gray-400 hover:text-gray-100 hover:bg-white/5"
              }`}
            >
              <item.icon
                size={17}
                className={isActive ? "text-white" : "text-gray-500"}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-3 border-t border-gray-800/50">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium text-gray-400 hover:text-red-400 hover:bg-red-500/10 w-full transition-all"
        >
          <LogOut size={17} className="text-gray-500" />
          Logout
        </button>
      </div>
    </aside>
  );
}
