import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, PlugZap, TriangleAlert, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/motion/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchCapabilities,
  setCapabilitySkill,
  setCapabilityTool,
  type CapabilitiesSnapshot,
} from "@/lib/universal-api";

export interface CapabilityPanelProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
}

/**
 * MCP 工具与技能面板。
 *
 * 回答两个问题：智能体现在到底能调用什么，以及哪些不该暴露给它。
 * 工具开关立即生效（MCP 服务器把该工具从 tools/list 摘掉）；技能开关对目录
 * 立即生效，但智能体的资源快照在下次连接时重建，所以要提示重连。
 */
export const CapabilityPanel: React.FC<CapabilityPanelProps> = ({ isOpen, onClose, agentId }) => {
  const [snapshot, setSnapshot] = useState<CapabilitiesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await fetchCapabilities(agentId));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!isOpen) return;
    void load();
  }, [isOpen, load]);

  if (!isOpen) return null;

  const toggle = async (kind: "tool" | "skill", name: string, enabled: boolean) => {
    setPending(`${kind}:${name}`);
    setError(null);
    // Optimistic: the switch must not lag behind the click.
    setSnapshot((prev) => {
      if (!prev) return prev;
      if (kind === "tool") {
        return {
          ...prev,
          mcp: {
            ...prev.mcp,
            tools: prev.mcp.tools.map((tool) => (tool.name === name ? { ...tool, enabled } : tool)),
          },
        };
      }
      return {
        ...prev,
        skills: prev.skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
      };
    });
    try {
      if (kind === "tool") await setCapabilityTool(name, enabled);
      else await setCapabilitySkill(name, enabled);
    } catch (e: any) {
      // Reload first: the reload clears the error, so the real reason has to
      // be set afterwards or the banner would flash and disappear.
      await load();
      setError(e?.message || String(e));
    } finally {
      setPending(null);
    }
  };

  const server = snapshot?.mcp.server ?? null;
  const supports = snapshot?.mcp.agentSupports;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[min(680px,calc(100vw-32px))] max-h-[88vh] overflow-y-auto border-border bg-card p-5">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <PlugZap className="w-5 h-5 text-primary" /> MCP 与技能
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            智能体当前能调用的工具、可读取的技能，以及它们的开关。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && !snapshot ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> 读取中…
          </div>
        ) : !snapshot ? null : (
          <>
            <section className="rounded-lg border border-border/60">
              <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs font-medium">
                <Plug className="w-3.5 h-3.5 text-muted-foreground" /> MCP 服务
              </header>
              <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 px-3 py-2.5 text-xs">
                <dt className="text-muted-foreground">内置服务</dt>
                <dd className="font-mono break-all">
                  {server ? (
                    <>
                      <span className="text-foreground">{server.name}</span>
                      <span className="text-muted-foreground"> · 端口 {server.port} · </span>
                      <span className="text-muted-foreground break-all">{server.url}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">未启动</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Agent 能力</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span className={supports?.http ? "text-foreground" : "text-muted-foreground"}>HTTP {supports?.http ? "✓" : "✗"}</span>
                  <span className={supports?.stdio ? "text-foreground" : "text-muted-foreground"}>stdio {supports?.stdio ? "✓" : "✗"}</span>
                  {!supports?.http && !supports?.stdio && (
                    <span className="text-muted-foreground">（该 Agent 未声明 MCP 能力，工具可能不会被挂载）</span>
                  )}
                </dd>
              </dl>
            </section>

            <section className="rounded-lg border border-border/60">
              <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs font-medium">
                <span className="flex items-center gap-2">
                  <Plug className="w-3.5 h-3.5 text-muted-foreground" /> 工具
                </span>
                <span className="text-muted-foreground">
                  {snapshot.mcp.tools.filter((tool) => tool.enabled).length}/{snapshot.mcp.tools.length} 已启用
                </span>
              </header>
              <ul className="divide-y divide-border/40">
                {snapshot.mcp.tools.map((tool) => (
                  <li key={tool.name} className="flex items-start justify-between gap-4 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{tool.title}</div>
                      <div className="text-[11px] text-muted-foreground">{tool.summary}</div>
                      <div className="text-[11px] font-mono text-muted-foreground/80 break-all">{tool.name}</div>
                    </div>
                    <Switch
                      checked={tool.enabled}
                      disabled={pending === `tool:${tool.name}`}
                      onCheckedChange={(checked) => void toggle("tool", tool.name, checked)}
                      ariaLabel={`${tool.title} 开关`}
                    />
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-lg border border-border/60">
              <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs font-medium">
                <span className="flex items-center gap-2">
                  <Wrench className="w-3.5 h-3.5 text-muted-foreground" /> 技能
                </span>
                <span className="text-muted-foreground">
                  {snapshot.skills.filter((skill) => skill.enabled).length}/{snapshot.skills.length} 已启用
                </span>
              </header>
              {snapshot.skills.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">没有找到内置技能。</p>
              ) : (
                <ul className="divide-y divide-border/40">
                  {snapshot.skills.map((skill) => (
                    <li key={skill.name} className="flex items-start justify-between gap-4 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-foreground">{skill.title || skill.name}</div>
                        <div className="text-[11px] text-muted-foreground">{skill.description}</div>
                        <div className="text-[11px] font-mono text-muted-foreground/80 break-all">{skill.name}</div>
                      </div>
                      <Switch
                        checked={skill.enabled}
                        disabled={pending === `skill:${skill.name}`}
                        onCheckedChange={(checked) => void toggle("skill", skill.name, checked)}
                        ariaLabel={`${skill.title || skill.name} 开关`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="text-[11px] text-muted-foreground">
              工具开关立即生效：被关闭的工具会从 MCP 的工具列表中移除，智能体无法再调用。
              技能开关对技能目录立即生效，并在智能体下次连接时不再进入它的资源快照。
            </p>
            <DialogFooter>
              <Button size="sm" variant="outline" onClick={onClose}>完成</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
