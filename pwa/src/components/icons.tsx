import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return <Icon {...props}><path d="m3 10.8 9-7.2 9 7.2v9.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 20.2z" /><path d="M9 22v-6h6v6" /></Icon>;
}

export function ScanIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 8V5.8C4 4.8 4.8 4 5.8 4H8" /><path d="M16 4h2.2c1 0 1.8.8 1.8 1.8V8" /><path d="M20 16v2.2c0 1-.8 1.8-1.8 1.8H16" /><path d="M8 20H5.8c-1 0-1.8-.8-1.8-1.8V16" /><path d="M8 10v4M11 9v6M14 9v6M17 10v4" /></Icon>;
}

export function HistoryIcon(props: IconProps) {
  return <Icon {...props}><path d="M3.4 12a8.6 8.6 0 1 0 2.3-5.9" /><path d="M3.4 4.8v4.1h4.1" /><path d="M12 7.3V12l3.1 2" /></Icon>;
}

export function AccountIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="8" r="3.4" /><path d="M4.8 21c.8-3.4 3.3-5.4 7.2-5.4s6.4 2 7.2 5.4" /></Icon>;
}

export function SearchIcon(props: IconProps) {
  return <Icon {...props}><circle cx="10.7" cy="10.7" r="5.8" /><path d="m15.2 15.2 4.6 4.6" /></Icon>;
}

export function StarIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return <Icon {...props} fill={filled ? "currentColor" : "none"}><path d="m12 3.5 2.62 5.3 5.85.85-4.23 4.12 1 5.82L12 16.83l-5.24 2.75 1-5.82L3.53 9.65l5.85-.85z" /></Icon>;
}

export function ShareIcon(props: IconProps) {
  return <Icon {...props}><circle cx="18" cy="5" r="2.3" /><circle cx="6" cy="12" r="2.3" /><circle cx="18" cy="19" r="2.3" /><path d="m8 10.9 7.9-4.7M8 13.1l7.9 4.7" /></Icon>;
}

export function ProductIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 6.5h14v11H5z" /><path d="M8 9.2v5.6M10.5 9.2v5.6M13.5 9.2v5.6M16 9.2v5.6" /><path d="M8 3.5h8" /></Icon>;
}

export function InfoIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="M12 10.7v5.2M12 7.7h.01" /></Icon>;
}

export function ChevronLeftIcon(props: IconProps) {
  return <Icon {...props}><path d="m14.5 5-7 7 7 7" /></Icon>;
}
