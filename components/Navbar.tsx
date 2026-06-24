import LogoutButton from "@/components/LogoutButton";

export default function Navbar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="flex min-h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div>
          <p className="text-sm font-medium text-slate-500">Internal Operations Platform</p>
          <h1 className="text-lg font-semibold text-slate-950">Quiksol Excel Intelligence System</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 sm:flex">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Supabase RLS ready
          </div>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
