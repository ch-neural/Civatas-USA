"use client";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";
import { listRecordings } from "@/lib/api";
import AgentExplorerPanel from "@/components/panels/AgentExplorerPanel";

export default function Page() {
  const wsId = useParams().id as string;
  const [recordingId, setRecordingId] = useState<string>("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await listRecordings();
        const predRecs = (res.recordings || [])
          .filter((r: any) => r.type === "prediction" && r.status === "completed")
          .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0));
        if (predRecs.length > 0) {
          setRecordingId(predRecs[0].recording_id);
        }
      } catch { }
      setReady(true);
    })();
  }, []);

  if (!ready) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>載入中...</div>;
  return <AgentExplorerPanel wsId={wsId} recordingId={recordingId} />;
}
