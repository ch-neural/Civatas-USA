"use client";

import { useParams } from "next/navigation";
import EvolutionPanel from "@/components/panels/EvolutionPanel";

export default function EvolutionRunnerPage() {
  const params = useParams();
  const wsId = params.id as string;
  return <EvolutionPanel wsId={wsId} defaultTab="runner" />;
}
