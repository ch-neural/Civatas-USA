"use client";
import { useParams } from "next/navigation";
import PredictionEvolutionDashboardPanel from "@/components/panels/PredictionEvolutionDashboardPanel";
export default function Page() {
  return <PredictionEvolutionDashboardPanel wsId={useParams().id as string} />;
}
