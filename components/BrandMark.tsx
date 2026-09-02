interface BrandMarkProps {
  size?: number;
  className?: string;
  label?: string;
}

export default function BrandMark({ size = 40, className = "", label }: BrandMarkProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-600 shadow-sm ${className}`}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 48 48" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 16h5M9 24h5M9 32h5M34 16h5M34 24h5M34 32h5M16 9v5M24 9v5M32 9v5M16 34v5M24 34v5M32 34v5" stroke="#BFDBFE" strokeWidth="2" strokeLinecap="round" />
        <rect x="14" y="14" width="20" height="20" rx="4" stroke="white" strokeWidth="2.5" />
        <path d="M19 28v-8h5M29 20h-5v8h5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="9" cy="16" r="1.5" fill="white" />
        <circle cx="39" cy="32" r="1.5" fill="white" />
        <circle cx="32" cy="9" r="1.5" fill="white" />
        <circle cx="16" cy="39" r="1.5" fill="white" />
      </svg>
    </span>
  );
}
