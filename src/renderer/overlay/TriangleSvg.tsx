/**
 * The buddy triangle: a fat round-joined stroke (= rounded corners) with two
 * eyes. One component shared by the mascot (BuddySvg in main.tsx) and the M19
 * helper sprites (HelperSvg in AgentHelpers.tsx) so the two stay pixel-
 * identical siblings — only size, tint and class hooks differ.
 */

export interface TriangleSvgProps {
  svgClassName: string;
  /** Rendered width/height in px (the viewBox is always 40x40). */
  size: number;
  /** Unique <defs> gradient id (helpers derive theirs from the agent id). */
  gradientId: string;
  /** Gradient top (light) / bottom (saturated) stops. */
  gradientTop: string;
  gradientBottom: string;
  /** Class on the triangle path (the mascot's error-flash hook), if any. */
  bodyClassName?: string;
  eyesClassName: string;
  pupilFill: string;
  /** Wrap the pupils in a <g> with this class (cursor-tracking transform). */
  pupilsClassName?: string;
  /** M15: imperative handle for cursor-tracking pupil offsets (transform-only). */
  pupilsRef?: React.RefObject<SVGGElement | null>;
}

export function TriangleSvg({
  svgClassName,
  size,
  gradientId,
  gradientTop,
  gradientBottom,
  bodyClassName,
  eyesClassName,
  pupilFill,
  pupilsClassName,
  pupilsRef,
}: TriangleSvgProps): React.JSX.Element {
  const fill = `url(#${gradientId})`;
  const pupils = (
    <>
      <circle cx={15.5} cy={25.1} r={1.55} fill={pupilFill} />
      <circle cx={25.9} cy={25.1} r={1.55} fill={pupilFill} />
    </>
  );
  return (
    <svg className={svgClassName} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={gradientTop} />
          <stop offset="1" stopColor={gradientBottom} />
        </linearGradient>
      </defs>
      {/* fat round-joined stroke = rounded corners on the triangle */}
      <path
        className={bodyClassName}
        d="M20 7 L34 32.5 L6 32.5 Z"
        fill={fill}
        stroke={fill}
        strokeWidth={7}
        strokeLinejoin="round"
      />
      <g className={eyesClassName}>
        <circle cx={14.8} cy={24.5} r={3.1} fill="#ffffff" />
        <circle cx={25.2} cy={24.5} r={3.1} fill="#ffffff" />
        {pupilsClassName !== undefined ? (
          <g className={pupilsClassName} ref={pupilsRef}>
            {pupils}
          </g>
        ) : (
          pupils
        )}
      </g>
    </svg>
  );
}
