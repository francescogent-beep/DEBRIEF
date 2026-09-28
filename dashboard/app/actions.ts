"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase-server";

export type ActionState = { error?: string; ok?: string } | undefined;

export async function joinWorkspace(_: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const code = String(form.get("code") || "").trim().toUpperCase();
  if (!code) return { error: "Enter an invite code" };
  const { data, error } = await supabase.rpc("join_workspace", { p_code: code });
  if (error) return { error: error.message };
  redirect(`/w/${data}`);
}

export async function createWorkspace(_: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const name = String(form.get("name") || "").trim();
  const template = String(form.get("template") || "generic");
  if (!name) return { error: "Give the workspace a name" };
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name, p_template: template });
  if (error) return { error: error.message };
  redirect(`/w/${data}/settings`);
}

export async function createInvite(form: FormData) {
  const supabase = await createClient();
  const ws = String(form.get("workspace_id"));
  const role = String(form.get("role")) === "manager" ? "manager" : "rep";
  await supabase.rpc("create_invite", { p_workspace: ws, p_role: role });
  revalidatePath(`/w/${ws}/settings`);
}

export async function setInviteActive(form: FormData) {
  const supabase = await createClient();
  const ws = String(form.get("workspace_id"));
  await supabase
    .from("invites")
    .update({ active: form.get("active") === "true" })
    .eq("code", String(form.get("code")));
  revalidatePath(`/w/${ws}/settings`);
}

export async function updateMember(form: FormData) {
  const supabase = await createClient();
  const ws = String(form.get("workspace_id"));
  const patch: Record<string, unknown> = {};
  if (form.has("role")) patch.role = form.get("role") === "manager" ? "manager" : "rep";
  if (form.has("active")) patch.active = form.get("active") === "true";
  await supabase.from("memberships").update(patch).eq("workspace_id", ws).eq("user_id", String(form.get("user_id")));
  revalidatePath(`/w/${ws}/settings`);
}

export async function addOption(form: FormData) {
  const supabase = await createClient();
  const ws = String(form.get("workspace_id"));
  const label = String(form.get("label") || "").trim();
  const kind = String(form.get("kind"));
  if (!label || !["outcome", "stage", "objection"].includes(kind)) return;
  const { data: last } = await supabase
    .from("options")
    .select("sort")
    .eq("workspace_id", ws)
    .eq("kind", kind)
    .order("sort", { ascending: false })
    .limit(1);
  await supabase
    .from("options")
    .insert({ workspace_id: ws, kind, label, sort: (last?.[0]?.sort ?? 0) + 1 });
  revalidatePath(`/w/${ws}/settings`);
}

export async function updateOption(form: FormData) {
  const supabase = await createClient();
  const ws = String(form.get("workspace_id"));
  const patch: Record<string, unknown> = {};
  if (form.has("label")) {
    const label = String(form.get("label")).trim();
    if (label) patch.label = label;
  }
  if (form.has("active")) patch.active = form.get("active") === "true";
  if (Object.keys(patch).length) {
    await supabase.from("options").update(patch).eq("id", String(form.get("id"))).eq("workspace_id", ws);
  }
  revalidatePath(`/w/${ws}/settings`);
}

export async function renameWorkspace(form: FormData) {
  const supabase = await createClient();
  const ws = String(form.get("workspace_id"));
  const name = String(form.get("name") || "").trim();
  if (name) await supabase.from("workspaces").update({ name }).eq("id", ws);
  revalidatePath(`/w/${ws}`, "layout");
}
