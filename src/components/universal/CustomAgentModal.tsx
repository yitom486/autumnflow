import React, { useState } from "react";
import { X, Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { upsertAgentProfile, deleteAgentProfile, type AgentSummary, type CustomAgentInput } from "@/lib/universal-api";

export interface CustomAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: AgentSummary[];
  onChanged: () => void;
}

const EMPTY: CustomAgentInput = { id: "", title: "", command: "", args: [] };

export const CustomAgentModal: React.FC<CustomAgentModalProps> = ({ isOpen, onClose, agents, onChanged }) => {
  const [form, setForm] = useState<CustomAgentInput>(EMPTY);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("{}");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!isOpen) return null;
  const customs = agents.filter((a) => !a.builtin);
  const set = (patch: Partial<CustomAgentInput>) => setForm((prev) => ({ ...prev, ...patch }));

  const startEdit = (a: AgentSummary) => {
    setEditingId(a.id);
    setForm({ id: a.id, title: a.title, name: a.name, description: a.description, command: a.command, args: a.args || [], authHint: a.authHint, installHint: a.installHint });
    setArgsText((a.args || []).join("\n"));
    setMsg(null);
  };

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY);
    setArgsText("");
    setEnvText("{}");
  };

  const save = async () => {
    if (!form.id.trim() || !form.command.trim()) {
      setMsg("id 与 command 必填。");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      let env: Record<string, string> = {};
      if (envText.trim()) {
        const parsed = JSON.parse(envText);
        if (parsed && typeof parsed === "object") env = parsed;
      }
      await upsertAgentProfile({
        ...form,
        id: form.id.trim(),
        args: argsText.split("\n").map((s) => s.trim()).filter(Boolean),
        env,
      });
      setMsg(`已保存 ${form.id.trim()}（持久化到 ~/.autumnflow/agents.json）。`);
      resetForm();
      onChanged();
    } catch (e: any) {
      setMsg("保存失败: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(`删除自定义 agent ${id}？`)) return;
    try {
      await deleteAgentProfile(id);
      onChanged();
    } catch (e: any) {
      setMsg("删除失败: " + e.message);
    }
  };

  const inputCls = "w-full rounded-lg bg-background border border-border px-3 py-1.5 text-xs text-foreground outline-none focus:border-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-5 text-foreground space-y-3 text-xs max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border pb-2">
          <h2 className="font-bold text-sm">自定义 Agent（壳原则：只填官方 CLI 入口）</h2>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {customs.length > 0 && (
          <div className="space-y-1.5">
            {customs.map((a) => (
              <div key={a.id} className="flex items-center gap-2 p-2 rounded-lg border border-border bg-background/60">
                <span className="font-mono font-semibold flex-1 truncate" title={`${a.command} ${(a.args || []).join(" ")}`}>{a.title} · {a.id}</span>
                <button onClick={() => startEdit(a)} title="编辑" className="p-1 text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                <button onClick={() => remove(a.id)} title="删除" className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">id（唯一）{editingId ? "（不可改）" : ""}</span>
            <input value={form.id} disabled={!!editingId} onChange={(e) => set({ id: e.target.value })} placeholder="my-agent" spellCheck={false} className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">显示名</span>
            <input value={form.title || ""} onChange={(e) => set({ title: e.target.value })} placeholder="My Agent" className={inputCls} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-muted-foreground">启动命令（官方 CLI 二进制，如 opencode / agent / dsh）</span>
            <input value={form.command} onChange={(e) => set({ command: e.target.value })} placeholder="opencode" spellCheck={false} className={`${inputCls} font-mono`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">参数（每行一个）</span>
            <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={3} spellCheck={false} placeholder={"acp\n--profile\nacp"} className={`${inputCls} font-mono`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">环境变量（JSON）</span>
            <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={3} spellCheck={false} placeholder={'{"DEEPSEEK_API_KEY": "sk-..."}'} className={`${inputCls} font-mono`} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-muted-foreground">认证说明（展示用：官方登录一次即可，不存密钥）</span>
            <input value={form.authHint || ""} onChange={(e) => set({ authHint: e.target.value })} placeholder="先跑一次官方登录，凭证留在官方位置" className={inputCls} />
          </label>
        </div>

        {msg && <div className="p-2 rounded-lg bg-background border border-border text-muted-foreground">{msg}</div>}

        <div className="flex justify-end gap-2">
          {editingId && <Button size="sm" variant="secondary" onClick={resetForm} className="text-xs">取消编辑</Button>}
          <Button size="sm" variant="default" onClick={save} disabled={busy} className="text-xs gap-1.5">
            <Plus className="w-3.5 h-3.5" /> {editingId ? "保存修改" : "添加"}
          </Button>
        </div>
      </div>
    </div>
  );
};
