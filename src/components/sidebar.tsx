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
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useRouter } from "next/navigation";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/pipeline", label: "Pipeline", icon: Columns3 },
  { href: "/products", label: "Products", icon: ShoppingBag },
  { href: "/inbox", label: "WhatsApp Inbox", icon: Inbox },
  { href: "/automations", label: "Automations", icon: Zap },
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
    <aside className="w-64 bg-gray-900 text-white flex flex-col min-h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-lg font-bold">COD WhatsApp</h1>
        <p className="text-xs text-gray-400">Delivery Notifications</p>
      </div>

      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm mb-1 transition-colors ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <item.icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-2 border-t border-gray-700">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-300 hover:bg-gray-800 hover:text-white w-full transition-colors"
        >
          <LogOut size={18} />
          Logout
        </button>
      </div>
    </aside>
  );
}
