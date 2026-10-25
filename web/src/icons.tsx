import type { ReactNode } from "react";

const Svg = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
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
  >
    {children}
  </svg>
);

export const Icon = {
  today: () => (
    <Svg>
      <path d="M3 12l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </Svg>
  ),
  apps: () => (
    <Svg>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  ),
  question: () => (
    <Svg>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2" />
      <path d="M12 16.5h.01" />
    </Svg>
  ),
  hand: () => (
    <Svg>
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5v-7a1.5 1.5 0 0 1 3 0V12" />
      <path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15.5a1.5 1.5 0 0 1 2.5-1.7L8 16" />
    </Svg>
  ),
  memory: () => (
    <Svg>
      <path d="M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.2A3.5 3.5 0 0 0 9 19h1v2h4v-2h1a3.5 3.5 0 0 0 3-5.8A3 3 0 0 0 16 8V7a4 4 0 0 0-4-4z" />
    </Svg>
  ),
  runs: () => (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  ),
  settings: () => (
    <Svg>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </Svg>
  ),
  play: () => (
    <Svg size={18}>
      <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  pause: () => (
    <Svg size={18}>
      <path d="M8 5v14M16 5v14" strokeWidth={2.6} />
    </Svg>
  ),
  external: () => (
    <Svg size={16}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  ),
  close: () => (
    <Svg>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  check: () => (
    <Svg size={18}>
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth={2.2} />
    </Svg>
  ),
  search: () => (
    <Svg size={18}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </Svg>
  ),
  logo: () => (
    <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path
        d="M20 33.5l8 8 16-17"
        fill="none"
        stroke="#fff"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};
