"use client";
import { useParams } from "next/navigation";
import PredictionPanel from "@/components/panels/PredictionPanel";
export default function Page() {
  return <PredictionPanel wsId={useParams().id as string} />;
}
