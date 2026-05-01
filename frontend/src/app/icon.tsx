import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/**
 * App icon / favicon — warm paper tile + ink “K” (visible on dark browser tabs).
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f5f4f0",
          borderRadius: 112,
        }}
      >
        <span
          style={{
            fontSize: 300,
            fontWeight: 700,
            color: "#2a2622",
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            letterSpacing: "-0.07em",
            lineHeight: 1,
          }}
        >
          K
        </span>
      </div>
    ),
    { ...size },
  );
}
