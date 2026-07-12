/** The buddy: a cheerful rounded blue triangle with little eyes. */

export function Triangle({ size = 20 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polygon
        points="12,4 21.5,20 2.5,20"
        fill="#4c8dff"
        stroke="#4c8dff"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <circle cx="9.4" cy="15.6" r="1.5" fill="#0f1115" />
      <circle cx="14.6" cy="15.6" r="1.5" fill="#0f1115" />
    </svg>
  );
}
