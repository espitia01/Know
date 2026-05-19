"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Analysis-pane dropdown (font scale, family, pane position).
 * Controlled menu + body portal — avoids base-ui Trigger/render quirks in the tab chrome.
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
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const { className: btnClassName, onClick: btnOnClick, ...restButtonProps } = buttonProps ?? {};

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = rect.bottom + sideOffset;
    if (align === "end") {
      setMenuStyle({ top, left: rect.right, transform: "translateX(-100%)" });
    } else if (align === "start") {
      setMenuStyle({ top, left: rect.left });
    } else {
      setMenuStyle({ top, left: rect.left + rect.width / 2, transform: "translateX(-50%)" });
    }
  }, [align, sideOffset]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onLayout = () => updatePosition();
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={ariaLabel}
            style={menuStyle}
            className={cn(
              "fixed z-[100] w-56 rounded-[var(--radius-lg)] border border-border bg-popover p-2 text-popover-foreground shadow-[var(--shadow-lg)] outline-none",
              className,
            )}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        {...restButtonProps}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        data-popup-open={open ? "" : undefined}
        className={cn(btnClassName)}
        onClick={(e) => {
          btnOnClick?.(e);
          if (e.defaultPrevented) return;
          setOpen((v) => !v);
        }}
      >
        {triggerInner}
      </button>
      {menu}
    </>
  );
}
