"use client";
import { DesktopShell } from "./shell/DesktopShell";

export function AppShell({ children }: { children: React.ReactNode }) {
  return <DesktopShell>{children}</DesktopShell>;
}
