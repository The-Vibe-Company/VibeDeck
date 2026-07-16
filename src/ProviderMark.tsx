export interface ProviderMarkProps {
  readonly providerId: string;
  readonly iconPath?: string | null;
  readonly size?: number;
}

const DEFAULT_SIZE = 40;
const MIN_SIZE = 16;
const MAX_SIZE = 96;

function safeSize(size: number | undefined) {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
}

/**
 * Icône locale et décorative d'un fournisseur. Le nom visible adjacent porte
 * l'information accessible ; l'image est donc volontairement masquée aux aides
 * techniques.
 */
export function ProviderMark({ providerId, iconPath = null, size }: ProviderMarkProps) {
  const renderedSize = safeSize(size);

  if (iconPath) {
    return (
      <span
        aria-hidden="true"
        className="provider-mark"
        data-provider-id={providerId}
        style={{
          width: renderedSize,
          minWidth: renderedSize,
          maxWidth: renderedSize,
          height: renderedSize,
          flex: `0 0 ${renderedSize}px`,
        }}
      >
        <img alt="" draggable="false" height={renderedSize} src={iconPath} width={renderedSize} />
      </span>
    );
  }

  return (
    <svg
      className="provider-mark provider-mark--fallback"
      aria-hidden="true"
      focusable="false"
      height={renderedSize}
      viewBox="0 0 48 48"
      width={renderedSize}
      xmlns="http://www.w3.org/2000/svg"
      style={{
        display: "block",
        minWidth: renderedSize,
        maxWidth: renderedSize,
        flex: `0 0 ${renderedSize}px`,
      }}
    >
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
    </svg>
  );
}

export default ProviderMark;
