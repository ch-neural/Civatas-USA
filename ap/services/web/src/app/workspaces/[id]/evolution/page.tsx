"use client";
import { useParams } from "next/navigation";
import EvolutionPanel from "@/components/panels/EvolutionPanel";
export default function Page() {
  return <EvolutionPanel wsId={useParams().id as string} />;
}
