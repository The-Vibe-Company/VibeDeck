export interface ProviderMarkProps {
  readonly providerId: string;
  readonly size?: number;
}

type ProviderVisual = "le-monde" | "le-figaro" | "le-parisien" | "fallback";

const DEFAULT_SIZE = 40;
const MIN_SIZE = 16;
const MAX_SIZE = 96;

function providerVisual(providerId: string): ProviderVisual {
  switch (providerId) {
    case "le-monde":
    case "le-figaro":
    case "le-parisien":
      return providerId;
    default:
      return "fallback";
  }
}

function safeSize(size: number | undefined) {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
}

/**
 * Marque locale et décorative d'un fournisseur. Le nom visible adjacent porte
 * l'information accessible ; le SVG est donc volontairement masqué aux aides
 * techniques.
 */
export function ProviderMark({ providerId, size }: ProviderMarkProps) {
  const visual = providerVisual(providerId);
  const renderedSize = safeSize(size);

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      height={renderedSize}
      viewBox="0 0 48 48"
      width={renderedSize}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      {visual === "le-monde" && (
        <>
          <rect width="48" height="48" rx="11" fill="#292e34" />
          <rect
            x="0.75"
            y="0.75"
            width="46.5"
            height="46.5"
            rx="10.25"
            fill="none"
            stroke="#454b51"
            strokeWidth="1.5"
          />
          <path
            d="M11.75 34V14.5L24 28.75 36.25 14.5V34"
            fill="none"
            stroke="#f4f1e9"
            strokeLinecap="square"
            strokeLinejoin="miter"
            strokeWidth="4.25"
          />
        </>
      )}

      {visual === "le-figaro" && (
        <>
          <rect width="48" height="48" rx="11" fill="#24465f" />
          <rect
            x="0.75"
            y="0.75"
            width="46.5"
            height="46.5"
            rx="10.25"
            fill="none"
            stroke="#42647a"
            strokeWidth="1.5"
          />
          <path
            d="M16 35V13H33M16 23.5H29.5"
            fill="none"
            stroke="#f3f2ed"
            strokeLinecap="square"
            strokeLinejoin="miter"
            strokeWidth="4.5"
          />
        </>
      )}

      {visual === "le-parisien" && (
        <>
          <rect width="48" height="48" rx="11" fill="#28535b" />
          <rect
            x="0.75"
            y="0.75"
            width="46.5"
            height="46.5"
            rx="10.25"
            fill="none"
            stroke="#487078"
            strokeWidth="1.5"
          />
          <path
            d="M15.5 35V13H25.75C32.35 13 36 16.2 36 21.5S32.35 30 25.75 30H15.5"
            fill="none"
            stroke="#f4f2ea"
            strokeLinecap="square"
            strokeLinejoin="round"
            strokeWidth="4.5"
          />
        </>
      )}

      {visual === "fallback" && (
        <>
          <rect width="48" height="48" rx="11" fill="#34383b" />
          <rect
            x="0.75"
            y="0.75"
            width="46.5"
            height="46.5"
            rx="10.25"
            fill="none"
            stroke="#505457"
            strokeWidth="1.5"
          />
          <path
            d="M14 14H34V34H14ZM19 20H29M19 25H29M19 30H25"
            fill="none"
            stroke="#dedbd3"
            strokeLinecap="square"
            strokeLinejoin="miter"
            strokeWidth="3"
          />
        </>
      )}
    </svg>
  );
}

export default ProviderMark;
