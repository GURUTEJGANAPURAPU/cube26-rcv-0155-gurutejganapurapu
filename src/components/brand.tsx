"use client";

type BrandProps = {
  size?: number;
  className?: string;
};

export function ArrivexMark({ size = 40, className = "" }: BrandProps) {
  return (
    <div
      className={`flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-label="Arrivex"
    >
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M8 46 32 8l24 38H43L32 28 21 46H8Z"
          fill="currentColor"
        />
        <path
          d="M20 46 32 26l12 20H20Z"
          fill="currentColor"
          opacity=".55"
        />
      </svg>
    </div>
  );
}

export function ArrivexWordmark({
  className = "",
}: {
  className?: string;
}) {
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      Arrivex
    </span>
  );
}