import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export type ResultBucketSectionProps = {
  open: boolean;
  onToggle: () => void;
  containerClassName: string;
  headerClassName: string;
  borderTopClassName: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  leading?: React.ReactNode;
  children: React.ReactNode;
};

export function ResultBucketSection({
  open,
  onToggle,
  containerClassName,
  headerClassName,
  borderTopClassName,
  title,
  subtitle,
  leading,
  children,
}: ResultBucketSectionProps) {
  return (
    <div className={containerClassName}>
      <button onClick={onToggle} className={headerClassName}>
        <div className="flex items-center gap-2">
          {leading}
          <span className="text-sm font-medium text-foreground">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
          {open ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open ? <div className={borderTopClassName}>{children}</div> : null}
    </div>
  );
}
