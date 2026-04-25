"use client";

import { Switch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

export function SwitchField({
  id,
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Switch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "group/switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border/70 bg-muted transition-colors",
        "hover:bg-muted/80",
        "data-[checked]:border-foreground/25 data-[checked]:bg-foreground",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "motion-safe:transition-[background-color,border-color] motion-safe:duration-150 motion-safe:ease-out",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      aria-label={ariaLabel}
    >
      <Switch.Thumb
        className={cn(
          "pointer-events-none block h-4 w-4 translate-x-0.5 rounded-full bg-background shadow-sm",
          "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]",
          "group-data-[checked]/switch:translate-x-[1.15rem] group-data-[checked]/switch:bg-background"
        )}
      />
    </Switch.Root>
  );
}
