import { useId, type SVGProps } from "react";

/**
 * The mark for "random faction": the four faction emblems in one.
 *
 * The die that used to stand here was a guess at the idea rather than the
 * thing FAF actually uses, and it read as a placeholder in a roster where
 * every other seat carries a real faction glyph.
 *
 * Inline rather than an `<img>`, so it scales with the text around it and
 * costs no request. The ids the masks and the clip path are referenced by are
 * generated per instance: a roster draws a dozen of these at once, and
 * repeating a fixed id a dozen times in one document is invalid and leaves
 * every copy pointing at the first one's definitions.
 *
 * The four colours are the factions' own, so this does not follow
 * `currentColor` the way the single-faction glyphs do.
 */
export function RandomFactionMark({
  size = 16,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number }) {
  const id = useId();
  const clip = `${id}-clip`;
  const mask = (index: number) => `${id}-mask${index}`;

  return (
    <svg
      height={size}
      width={size}
      viewBox="0 0 500 500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath={`url(#${clip})`}>
        <mask
          id={mask(0)}
          style={{ maskType: "luminance" }}
          maskUnits="userSpaceOnUse"
          x="377"
          y="19"
          width="197"
          height="478"
        >
          <path d="M573.64 19.4502H377.99V497H573.64V19.4502Z" fill="white" />
        </mask>
        <g mask={`url(#${mask(0)})`}>
          <path
            d="M312.68 461.17C331.31 442.99 343.52 414.53 343.52 382.99C343.52 372.2 342.12 361.81 339.53 352.07C340.08 343.32 342.56 325.08 335.27 298.5C327.97 271.85 311.01 252.81 300.6 242.18C316.32 238.24 330.13 225.6 339.49 209.46C348.85 193.32 359.76 167.7 363.43 124.17C367.09 80.6403 354.74 24.9803 348.88 4.82031C363.8 22.1703 384.06 57.3703 397.16 90.6503C410.26 123.92 424.28 175.18 429.75 211.34C435.21 247.5 436.45 270.35 432.03 294.48C414.9 284.44 404.43 291.83 399.71 295.15C394.99 298.47 384.93 309.58 380.13 322.78C375.33 335.97 373.5 355.29 375.84 369.58C378.18 383.87 383.71 387.65 388.63 387.57C393.55 387.49 402.35 384.72 420.23 363.54C438.1 342.36 451.23 316.92 456.04 304.13C460.84 291.34 468.5 271.29 473.61 247.54C478.53 290.02 470.37 330.99 459.93 358.85C449.49 386.71 433.51 416.12 400.39 452.72C367.26 489.32 332.51 511.69 296.59 519.77C301.69 512.98 306.75 501.64 309.2 491.61C311.65 481.58 312.76 469.88 312.69 461.17H312.68Z"
            fill="#F7BC0B"
          />
        </g>
        <mask
          id={mask(1)}
          style={{ maskType: "luminance" }}
          maskUnits="userSpaceOnUse"
          x="267"
          y="19"
          width="111"
          height="478"
        >
          <path d="M378 19.4502H267.5V497H378V19.4502Z" fill="white" />
        </mask>
        <g mask={`url(#${mask(1)})`}>
          <path
            d="M264.01 234.74C244.67 268.24 225.33 301.74 205.98 335.25H322.03C302.69 301.75 283.35 268.25 264 234.74H264.01Z"
            fill="#E31B13"
          />
          <path
            d="M364.52 345.84C414.49 374.76 464.45 403.68 514.42 432.6C489.4 389.27 464.39 345.95 439.37 302.62C433.57 305.97 427.76 309.32 421.96 312.67C413.92 298.74 405.88 284.82 397.84 270.89C411.26 247.67 424.67 224.45 438.09 201.23C411.27 201.23 384.46 201.25 357.64 201.26C349.6 187.33 341.56 173.41 333.52 159.48C339.32 156.13 345.13 152.78 350.93 149.43C325.92 106.1 300.9 62.7802 275.89 19.4502C275.95 77.1802 276.02 134.92 276.08 192.65C305.56 243.72 335.04 294.78 364.53 345.85L364.52 345.84Z"
            fill="#E31B13"
          />
          <path
            d="M175.57 366.73C125.54 395.54 75.51 424.35 25.48 453.17H175.57V433.07H223.81C237.21 456.3 250.61 479.53 264.01 502.75C277.41 479.52 290.81 456.29 304.21 433.07H352.45V453.17H502.54C452.51 424.36 402.48 395.55 352.45 366.73H175.56H175.57Z"
            fill="#E31B13"
          />
        </g>
        <mask
          id={mask(2)}
          style={{ maskType: "luminance" }}
          maskUnits="userSpaceOnUse"
          x="157"
          y="-6"
          width="111"
          height="506"
        >
          <path d="M267.5 -5.3501H157V500H267.5V-5.3501Z" fill="white" />
        </mask>
        <g mask={`url(#${mask(2)})`}>
          <path
            d="M264.57 345.13C251.85 345.13 241.52 379.16 241.52 421.06C241.52 462.96 251.85 496.99 264.57 496.99C277.29 496.99 287.62 462.96 287.62 421.06C287.62 379.16 277.29 345.13 264.57 345.13Z"
            fill="#3DA936"
          />
          <path
            d="M264.57 247.51C222.67 247.51 188.64 186.74 188.64 111.92C188.64 67.2601 200.77 27.6001 219.46 2.89014C143.87 34.5701 88.3098 145.58 88.3198 277.45C90.1198 277.38 91.9198 277.34 93.7298 277.34C159.11 277.34 213.77 323.75 226.15 385.45C231.68 343.06 246.81 312.6 264.58 312.6C282.35 312.6 297.48 343.06 303.01 385.45C315.39 323.75 370.05 277.34 435.43 277.34C437.24 277.34 439.05 277.38 440.84 277.45C440.85 145.59 385.29 34.5701 309.7 2.89014C328.39 27.6001 340.52 67.2601 340.52 111.92C340.52 186.74 306.48 247.51 264.59 247.51H264.57Z"
            fill="#3DA936"
          />
        </g>
        <mask
          id={mask(3)}
          style={{ maskType: "luminance" }}
          maskUnits="userSpaceOnUse"
          x="17"
          y="22"
          width="140"
          height="478"
        >
          <path d="M157 22.4502H17.5698V500H157V22.4502Z" fill="white" />
        </mask>
        <g mask={`url(#${mask(3)})`}>
          <path
            d="M92.0799 332.171C68.4299 308.521 44.7799 284.871 21.1299 261.221C44.7799 237.571 68.4299 213.921 92.0799 190.271C115.73 213.921 139.38 237.571 163.03 261.221C139.38 284.871 115.73 308.521 92.0799 332.171Z"
            fill="#3884C5"
          />
          <path
            d="M177.22 417.31C153.57 393.66 129.92 370.01 106.27 346.36C129.92 322.71 153.57 299.06 177.22 275.41C200.87 299.06 224.52 322.71 248.17 346.36C224.52 370.01 200.87 393.66 177.22 417.31Z"
            fill="#3884C5"
          />
          <path
            d="M262.35 332.17C210.48 280.3 158.61 228.43 106.74 176.56C158.61 124.37 210.48 72.1903 262.35 20.0103C314.38 72.0403 366.4 124.06 418.43 176.09C366.4 228.12 314.38 280.14 262.35 332.17Z"
            fill="#3884C5"
          />
        </g>
      </g>
      <defs>
        <clipPath id={clip}>
          <rect width="500" height="500" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}
