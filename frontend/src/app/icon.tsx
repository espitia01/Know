import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/** High-DPI favicon — crisp “K” mark scaled down by the browser. */
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
          background: "linear-gradient(152deg, #2a3140 0%, #1a1d26 42%, #3d4558 100%)",
          borderRadius: 112,
        }}
      >
        <span
          style={{
            fontSize: 300,
            fontWeight: 700,
            color: "#f4f4f5",
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            letterSpacing: "-0.06em",
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
