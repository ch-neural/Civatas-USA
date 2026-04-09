"use client";
import { useState, useEffect } from "react";
import { useLocaleStore } from "@/store/locale-store";

interface GuideBannerProps {
  guideKey: string;
  title: string;
  titleEn: string;
  message: string;
  messageEn: string;
}

const STORAGE_KEY = "civatas_dismissed_guides";

function getDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function dismiss(key: string) {
  const current = getDismissed();
  if (!current.includes(key)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...current, key]));
  }
}

export function dismissAllGuides() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(["__all__"]));
}

export function GuideBanner({
  guideKey,
  title,
  titleEn,
  message,
  messageEn,
}: GuideBannerProps) {
  const en = useLocaleStore((s) => s.locale) === "en";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = getDismissed();
    if (dismissed.includes("__all__") || dismissed.includes(guideKey)) {
      setVisible(false);
    } else {
      setVisible(true);
    }
  }, [guideKey]);

  if (!visible) return null;

  return (
    <div className="bg-[#e94560]/10 border border-[#e94560]/25 rounded-lg px-4 py-3 mb-4 flex items-start gap-3">
      <span className="text-lg mt-0.5">💡</span>
      <div className="flex-1 min-w-0">
        <div className="text-neutral-200 text-sm font-medium">
          {en ? titleEn : title}
        </div>
        <div className="text-neutral-400 text-xs mt-1 leading-relaxed">
          {en ? messageEn : message}
        </div>
      </div>
      <button
        className="text-neutral-500 hover:text-neutral-300 text-lg shrink-0"
        onClick={() => {
          dismiss(guideKey);
          setVisible(false);
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
