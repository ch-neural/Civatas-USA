"use client";
import { useParams } from "next/navigation";
import PersonaPanel from "@/components/panels/PersonaPanel";
export default function Page() {
  return <PersonaPanel wsId={useParams().id as string} />;
}
