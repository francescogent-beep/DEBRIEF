import { createClient } from "@supabase/supabase-js";
import { EXPORTS, toCsv } from "@/lib/exports";
import { TEAM_TZ } from "@/lib/time";

// Public CSV feed, protected by the workspace's secret export key in the URL.
// Used by the Download buttons and by Google Sheets' =IMPORTDATA().
//   /export/<key>/daily-report.csv?days=90
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string; file: string }> }) {
  const { token, file } = await params;
  const def = EXPORTS.find((e) => e.file === file);
  if (!def || !/^[0-9a-f]{32,64}$/.test(token)) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 90, 1), 366);

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("export_data", {
    p_token: token,
    p_kind: def.kind,
    p_days: days,
    p_tz: TEAM_TZ,
  });
  if (error) {
    const invalid = /Invalid export link/i.test(error.message);
    return new Response(invalid ? "This export link is no longer valid." : "Export failed.", {
      status: invalid ? 404 : 500,
    });
  }

  const csv = toCsv((data ?? []) as Record<string, unknown>[], def.columns);
  const download = url.searchParams.has("download");
  // The byte-order mark helps Excel read accents correctly; Sheets doesn't need it.
  return new Response(download ? "\uFEFF" + csv : csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      ...(download ? { "Content-Disposition": `attachment; filename="${def.file}"` } : {}),
    },
  });
}
