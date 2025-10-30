import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";

function verifyCron(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET environment variable is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const header = req.headers.get("authorization");
  if (!header) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expected = `Bearer ${cronSecret}`;
  const expectedBuffer = Buffer.from(expected, "utf-8");
  const providedBuffer = Buffer.from(header, "utf-8");

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return authError;

  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from("file_recovery")
      .select("id,storage_path")
      .lte("deleted_at", cutoff)
      .is("restored_at", null);

    if (error) throw error;

    for (const entry of data ?? []) {
      if (entry.storage_path) {
        const { error: removeError } = await supabaseAdmin.storage.from(BUCKET).remove([entry.storage_path]);
        if (removeError) {
          console.error("Failed to purge recovery vault storage:", removeError);
          continue;
        }
      }
      await supabaseAdmin.from("file_recovery").delete().eq("id", entry.id);
    }

    return NextResponse.json({ ok: true, purged: data?.length ?? 0 });
  } catch (error: any) {
    console.error("Recovery vault purge failed:", error);
    return NextResponse.json({ error: "Failed to purge recovery vault" }, { status: 500 });
  }
}
