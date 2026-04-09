"use client";
import { useRouter } from "next/navigation";
import { useLocaleStore } from "@/store/locale-store";

interface StepGateProps {
  requiredStep: number;
  requiredStepName: string;
  requiredStepNameEn: string;
  description: string;
  descriptionEn: string;
  targetRoute: string;
}

export function StepGate({
  requiredStep,
  requiredStepName,
  requiredStepNameEn,
  description,
  descriptionEn,
  targetRoute,
}: StepGateProps) {
  const router = useRouter();
  const en = useLocaleStore((s) => s.locale) === "en";

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
      <div className="text-5xl mb-4">🔒</div>
      <h2 className="text-xl font-semibold text-neutral-200 mb-2">
        {en
          ? `Step ${requiredStep}: ${requiredStepNameEn} Required`
          : `需要先完成第 ${requiredStep} 步：${requiredStepName}`}
      </h2>
      <p className="text-neutral-500 text-sm mb-6 max-w-md">
        {en ? descriptionEn : description}
      </p>
      <button
        className="bg-[#e94560] hover:bg-[#d63851] text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
        onClick={() => router.push(targetRoute)}
      >
        {en
          ? `Go to ${requiredStepNameEn} →`
          : `前往${requiredStepName} →`}
      </button>
    </div>
  );
}
