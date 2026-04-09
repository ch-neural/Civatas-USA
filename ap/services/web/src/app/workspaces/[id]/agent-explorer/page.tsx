"use client";
import { useParams } from "next/navigation";
import AgentExplorerPanel from "@/components/panels/AgentExplorerPanel";
export default function Page() {
  return <AgentExplorerPanel wsId={useParams().id as string} />;
}
