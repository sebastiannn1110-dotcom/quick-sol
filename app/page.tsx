import { redirect } from "next/navigation";
import { AUTHENTICATED_HOME_PATH } from "@/lib/auth/redirects";

export default function HomePage() {
  redirect(AUTHENTICATED_HOME_PATH);
}
