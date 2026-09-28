"use client";

import { useActionState } from "react";
import { joinWorkspace, createWorkspace, type ActionState } from "@/app/actions";

export function JoinForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(joinWorkspace, undefined);
  return (
    <form action={action} className="stack">
      <label>
        Invite code
        <input name="code" className="code-input" placeholder="ABCD2345" maxLength={12} autoComplete="off" required />
      </label>
      {state?.error && <p className="msg">{state.error}</p>}
      <button className="btn primary" disabled={pending}>Join workspace</button>
    </form>
  );
}

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createWorkspace, undefined);
  return (
    <form action={action} className="stack">
      <label>
        Workspace name
        <input name="name" placeholder="7FigureRia" required maxLength={80} />
      </label>
      <label>
        Starting template
        <select name="template" defaultValue="7figureria">
          <option value="7figureria">Financial advisor setting (7FigureRia)</option>
          <option value="generic">Generic appointment setting</option>
        </select>
      </label>
      {state?.error && <p className="msg">{state.error}</p>}
      <button className="btn primary" disabled={pending}>Create workspace</button>
    </form>
  );
}
