"use client";
import { useParams } from "next/navigation";
import PredictionAnalysisPanel from "@/components/panels/PredictionAnalysisPanel";
export default function Page() {
  return <PredictionAnalysisPanel wsId={useParams().id as string} />;
}
