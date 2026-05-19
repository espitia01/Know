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

const PADDING = 8;
const DEFAULT_MENU_W = 224;

/**
 * Analysis-pane dropdown (font scale, family, pane position).
 * Controlled menu + body portal — viewport-clamped positioning.
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
    if (!el || typeof window === "undefined") return;
    const triggerRect = el.getBoundingClientRect();
    const menuW = menuRef.current?.offsetWidth ?? DEFAULT_MENU_W;
    const menuH = menuRef.current?.offsetHeight ?? 0;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left: number;
    if (align === "end") left = triggerRect.right - menuW;
    else if (align === "start") left = triggerRect.left;
    else left = triggerRect.left + triggerRect.width / 2 - menuW / 2;

    left = Math.max(PADDING, Math.min(left, viewportW - menuW - PADDING));

    let top = triggerRect.bottom + sideOffset;
    if (menuH > 0 && top + menuH > viewportH - PADDING) {
      const flipTop = triggerRect.top - sideOffset - menuH;
      if (flipTop >= PADDING) top = flipTop;
      else top = Math.max(PADDING, viewportH - menuH - PADDING);
    }

    setMenuStyle({ top, left });
  }, [align, sideOffset]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(() => updatePosition());
    const onLayout = () => updatePosition();
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => updatePosition());
    ro.observe(menu);
    return () => ro.disconnect();
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
