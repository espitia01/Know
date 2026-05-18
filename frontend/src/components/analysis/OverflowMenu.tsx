"use client";

import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

/**
 * Stage 5 primitive: replaces the bespoke 80-line portaled menu in
 * `BottomPanel` (kebab → font scale + pane position) with a base-ui
 * Popover wrapper. Same visual surface, same focus / outside-click /
 * Escape semantics — but managed by base-ui's positioner so we don't
 * have to maintain our own scroll/resize listeners or coordinate math.
 *
 * The component intentionally exposes `Popover.Trigger` directly via
 * `trigger`. Callers pass their own button so they can keep existing
 * data-state / aria styling. The popup's chrome (border, shadow,
 * radius, padding) lives here so every analysis-pane menu inherits
 * the same visual language without each call site re-doing it.
 */
export function OverflowMenu({
  trigger,
  children,
  align = "end",
  sideOffset = 6,
  className,
  ariaLabel,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        // base-ui exposes the trigger as a render prop — we don't pass
        // children directly because callers want to keep their own
        // <button>; render={(props) => <button {...props} />} is the
        // documented escape hatch for that.
        render={(props) => <span {...props}>{trigger}</span>}
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={sideOffset}>
          <Popover.Popup
            aria-label={ariaLabel}
            className={cn(
              "z-50 w-56 rounded-[var(--radius-lg)] border border-border bg-popover p-2 text-popover-foreground shadow-[var(--shadow-lg)] outline-none",
              className,
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
