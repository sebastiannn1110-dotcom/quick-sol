import { describe, expect, it } from "vitest";
import {
  avatarFallbackText,
  avatarPublicUrl,
  isJasonDemoOwnerEmail,
  usesJasonInitialAvatar,
  validateAvatarFile
} from "@/lib/profile/avatar";

describe("avatar validation", () => {
  it("allows supported image formats", () => {
    expect(validateAvatarFile(new File(["image"], "avatar.png", { type: "image/png" })).valid).toBe(true);
  });

  it("rejects scripts and empty files", () => {
    expect(validateAvatarFile(new File(["alert(1)"], "avatar.svg", { type: "image/svg+xml" })).valid).toBe(false);
    expect(validateAvatarFile(new File([], "empty.png", { type: "image/png" })).valid).toBe(false);
  });

  it("builds an encoded public Storage URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    expect(avatarPublicUrl("user/a photo.png")).toBe("https://example.supabase.co/storage/v1/object/public/avatars/user/a%20photo.png");
  });

  it("returns allowlisted local demo people WebP paths without requiring Supabase", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(avatarPublicUrl("/demo/people/jason.webp")).toBe("/demo/people/jason.webp");
    expect(avatarPublicUrl("demo/people/maya-torres.webp")).toBe("/demo/people/maya-torres.webp");
  });

  it("rejects every other local-path shape", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    expect(avatarPublicUrl("/demo/companies/jason.webp")).toBeNull();
    expect(avatarPublicUrl("/demo/people/nested/jason.webp")).toBeNull();
    expect(avatarPublicUrl("/demo/people/jason.png")).toBeNull();
    expect(avatarPublicUrl("/demo/people/Jason.webp")).toBeNull();
    expect(avatarPublicUrl("/demo/people/jason_boss.webp")).toBeNull();
    expect(avatarPublicUrl("/demo/people/../jason.webp")).toBeNull();
    expect(avatarPublicUrl("demo/people/jason.webp?version=2")).toBeNull();
  });

  it("recognizes Jason's permanent single-letter demo avatar", () => {
    expect(isJasonDemoOwnerEmail("jasonBoss@quiksol.com")).toBe(true);
    expect(isJasonDemoOwnerEmail(" JASONBOSS@QUIKSOL.COM ")).toBe(true);
    expect(isJasonDemoOwnerEmail("maya.torres@quiksol.demo.invalid")).toBe(false);
    expect(usesJasonInitialAvatar("Jason Boss")).toBe(true);
    expect(usesJasonInitialAvatar("Jason Boss \u2014 DEMO")).toBe(true);
    expect(usesJasonInitialAvatar("Renamed owner", "jasonBoss@quiksol.com")).toBe(true);
    expect(usesJasonInitialAvatar("Olivia Mercer \u2014 DEMO")).toBe(false);
    expect(avatarFallbackText("Jason Boss \u2014 DEMO")).toBe("J");
    expect(avatarFallbackText("Jason Boss \u2014 DEMO")).not.toBe("JB");
  });
});
