import type { SVGProps } from 'react';

const PATHS: Record<string, string[]> = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M9 21v-6h6v6'],
  megaphone: ['M3 11v3l14 4V6L3 10', 'M7 14v4a2 2 0 0 0 4 0v-3.5', 'M17 8l4-1v10l-4 1'],
  coin: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v10', 'M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.9-2.5 2s1 1.8 2.5 2 2.5.9 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5'],
  channel: ['M4.9 19.1a10 10 0 0 1 0-14.2', 'M19.1 4.9a10 10 0 0 1 0 14.2', 'M7.8 16.2a6 6 0 0 1 0-8.4', 'M16.2 7.8a6 6 0 0 1 0 8.4', 'M12 12h.01'],
  wallet: ['M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M3 9h18', 'M16 14h.01'],
  back: ['M15 18l-6-6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm21 21-4.3-4.3'],
  chevronRight: ['m9 6 6 6-6 6'],
  check: ['M5 13l4 4L19 7'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  alert: ['M12 3 2.5 20h19L12 3Z', 'M12 9.5V14', 'M12 17h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5', 'M12 8h.01'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h4', 'M12 17h8', 'M14 4.8a2.5 2.5 0 1 1 0 4.4 2.5 2.5 0 0 1 0-4.4Z', 'M8 14.8a2.5 2.5 0 1 1 0 4.4 2.5 2.5 0 0 1 0-4.4Z'],
  user: ['M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  shield: ['M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3Z', 'm9 12 2 2 4-4'],
  doc: ['M6 3h9l4 4v14H6V3Z', 'M15 3v4h4', 'M9 12h7', 'M9 16h7'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6.5 7l1 13h9l1-13'],
  edit: ['M4 20l1-4L16 5l3 3L8 19l-4 1Z', 'M13.5 7.5l3 3'],
  refresh: ['M20 11a8 8 0 0 0-14.9-3', 'M4 13a8 8 0 0 0 14.9 3', 'M5 4v4h4', 'M19 20v-4h-4'],
  send: ['m22 2-11 11', 'M22 2 15 22l-4-9-9-4 20-7Z'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-6', 'M22 20H2'],
  copy: ['M9 9h11v11H9V9Z', 'M5 15H4V4h11v1'],
  eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z'],
  arrowDown: ['M12 5v14', 'm6 13 6 6 6-6'],
  arrowUp: ['M12 19V5', 'm6 11 6-6 6 6'],
  dollar: ['M12 3v18', 'M16 7.5C15.5 6 14 5.5 12 5.5c-2.2 0-3.8 1-3.8 2.7 0 3.8 7.6 2 7.6 6 0 1.9-1.8 2.8-3.8 2.8-2.3 0-3.8-.8-4.2-2.5'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M9 5H5v14h14v-4'],
  grid: ['M4 4h7v7H4V4Z', 'M13 4h7v7h-7V4Z', 'M4 13h7v7H4v-7Z', 'M13 13h7v7h-7v-7Z'],
  target: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 12h.01'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8L4 5Z'],
  logout: ['M14 4h6v16h-6', 'M10 8l-4 4 4 4', 'M6 12h10'],
  bell: ['M6 8.5a6 6 0 0 1 12 0c0 4.6 2 6.5 2 6.5H4s2-1.9 2-6.5Z', 'M10.3 20a2 2 0 0 0 3.4 0'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9 2.6-5.3Z'],
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: keyof typeof PATHS;
  size?: number;
}

export function Icon({ name, size = 22, ...rest }: IconProps) {
  const paths = PATHS[name] ?? PATHS.info;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export type IconName = keyof typeof PATHS;
