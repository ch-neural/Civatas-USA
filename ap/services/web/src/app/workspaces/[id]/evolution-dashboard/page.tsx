"use client";
import { useParams } from "next/navigation";
import EvolutionDashboardPanel from "@/components/panels/EvolutionDashboardPanel";
export default function Page() {
  return <EvolutionDashboardPanel wsId={useParams().id as string} />;
}
