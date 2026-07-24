const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

export function validateClientImage(value: FormDataEntryValue | null) {
  if (!(value instanceof File)) return { error: "Image file is required." } as const;
  const extension = EXTENSIONS[value.type];
  if (!extension) return { error: "Only PNG, JPEG and WebP images are allowed." } as const;
  if (value.size <= 0 || value.size > 5 * 1024 * 1024) return { error: "Image must be smaller than 5 MB." } as const;
  return { file: value, extension } as const;
}
