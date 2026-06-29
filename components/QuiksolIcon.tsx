import Image from "next/image";

export default function QuiksolIcon({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center overflow-hidden rounded-md bg-white ${className}`} style={{ width: size, height: size }}>
      <Image src="/logo-ia.png" alt="" width={size} height={size} className="h-full w-full object-cover" />
    </span>
  );
}
