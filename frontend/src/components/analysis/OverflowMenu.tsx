"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

/**
 * Stage 5 primitive: base-ui Popover for analysis-pane menus.
 * Callers pass `triggerInner` + `buttonProps`; base-ui owns a single
 * `<button>` so we never nest interactive elements (Bug 1).
 */
export function OverflowMenu({
  triggerInner,
  buttonProps,
  children,
  align = "end",
  sideOffset = 6,
  className,
  ariaLabel,
}: {
  triggerInner: ReactNode;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  children: ReactNode;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const { className: btnClassName, ...restButtonProps } = buttonProps ?? {};
  return (
    <Popover.Root>
      <Popover.Trigger
        render={(triggerProps) => (
          <button
            type="button"
            {...restButtonProps}
            {...triggerProps}
            className={cn(btnClassName, triggerProps.className)}
          >
            {triggerInner}
          </button>
        )}
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
