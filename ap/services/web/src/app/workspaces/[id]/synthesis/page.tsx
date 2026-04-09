"use client";
import { useParams } from "next/navigation";
import SynthesisResultPanel from "@/components/panels/SynthesisResultPanel";
export default function Page() {
  return <SynthesisResultPanel wsId={useParams().id as string} />;
}
