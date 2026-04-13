"use client";
import { useParams } from "next/navigation";
import EvolutionQuickStartPanel from "@/components/panels/EvolutionQuickStartPanel";
export default function Page() {
  return <EvolutionQuickStartPanel wsId={useParams().id as string} />;
}
