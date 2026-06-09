import React from "react";
import type { ChecklistItem, ChecklistStatus } from "@shared/types";

const ICON: Record<ChecklistStatus, string> = {
  open: "○",
  covered: "✓",
  partial: "◐",
  skipped: "—",
};

const NEXT: Record<ChecklistStatus, ChecklistStatus> = {
  open: "covered",
  covered: "partial",
  partial: "skipped",
  skipped: "open",
};

export function Checklist({
  items,
  onToggle,
}: {
  items: ChecklistItem[];
  onToggle: (id: string, status: ChecklistStatus) => void;
}): JSX.Element | null {
  if (!items.length) return null;
  return (
    <div className="prompty-checklist">
      <div className="prompty-label">Checklist</div>
      {items.map((it) => (
        <div
          key={it.id}
          className={`prompty-check prompty-check-${it.status}`}
          onClick={() => onToggle(it.id, NEXT[it.status])}
        >
          <span className="prompty-check-icon">{ICON[it.status]}</span>
          <span className="prompty-check-text">{it.text}</span>
        </div>
      ))}
    </div>
  );
}
