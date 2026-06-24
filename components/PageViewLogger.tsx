"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { clientLogger } from "@/lib/logger/clientLogger";

export default function PageViewLogger() {
  const pathname = usePathname();

  useEffect(() => {
    clientLogger.pageView({ path: pathname });
  }, [pathname]);

  return null;
}
