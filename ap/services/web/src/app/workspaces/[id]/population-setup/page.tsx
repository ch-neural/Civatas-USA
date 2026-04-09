"use client";
import { useParams } from "next/navigation";
import PopulationSetupPanel from "@/components/panels/PopulationSetupPanel";

export default function Page() {
  return <PopulationSetupPanel wsId={useParams().id as string} />;
}
