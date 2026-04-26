import type { IconKind } from "../types";

interface PartIconProps {
  kind: IconKind;
}

export default function PartIcon({ kind }: PartIconProps) {
  const stroke = "currentColor";
  if (kind === "board")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <circle cx="7" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="17" cy="12" r="1" />
      </svg>
    );

  if (kind === "sonar")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <circle cx="8" cy="12" r="3" />
        <circle cx="16" cy="12" r="3" />
      </svg>
    );

  if (kind === "servo")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <rect x="5" y="7" width="14" height="10" rx="1" />
        <circle cx="12" cy="12" r="2" />
        <line x1="12" y1="5" x2="12" y2="9" />
      </svg>
    );

  if (kind === "led")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <circle cx="12" cy="10" r="5" />
        <line x1="10" y1="15" x2="10" y2="22" />
        <line x1="14" y1="15" x2="14" y2="22" />
      </svg>
    );

  if (kind === "res")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <path d="M2 12 H6 L8 8 L12 16 L16 8 L18 12 H22" />
      </svg>
    );

  if (kind === "buzzer")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    );

  if (kind === "eye")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );

  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.6">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}
