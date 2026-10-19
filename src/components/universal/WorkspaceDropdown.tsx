import React, { useState, useRef, useEffect } from "react";
import { Folder, FolderOpen, ExternalLink, ChevronDown, Check, Clock } from "lucide-react";
import { validateWorkspace } from "@/lib/universal-api";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import type { RecentWorkspace } from "@/stores/useStudioStore";

export interface WorkspaceDropdownProps {
  currentWorkspace: string | null;
  recentWorkspaces: RecentWorkspace[];
  onSelectWorkspace: (path: string, name?: string) => void;
}

export const WorkspaceDropdown: React.FC<WorkspaceDropdownProps> = ({
  currentWorkspace,
  recentWorkspaces,
  onSelectWorkspace,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const projectName = currentWorkspace
    ? currentWorkspace.split(/[/\\]/).filter(Boolean).pop() || currentWorkspace
    : null;

  // Close dropdown on click outside
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  // Handle folder opening via in-app WorkspacePickerModal
  const handleOpenFolder = () => {
    setOpen(false);
    useWorkbenchStore.getState().openWorkspacePicker();
  };

  const handleRevealInExplorer = async () => {
    setOpen(false);
    if (currentWorkspace && window.autumnflow?.openPath) {
      await window.autumnflow.openPath(currentWorkspace);
    }
  };

  return (
    <div className="relative flex items-center app-no-drag" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={currentWorkspace ? `当前工作区: ${currentWorkspace}` : "点击选择本地工作区目录"}
        className="h-7 flex items-center gap-1.5 px-2 rounded-md border border-transparent hover:border-border hover:bg-muted text-xs text-foreground transition-colors max-w-[170px] sm:max-w-[240px]"
      >
        <Folder className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="truncate font-mono text-[12px]">
          {projectName || "打开工作区…"}
        </span>
        <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0 ml-0.5" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-64 p-1 rounded-lg border border-border bg-popover shadow-lg text-xs z-50">
          {/* Open Folder Action */}
          <button
            type="button"
            onClick={handleOpenFolder}
            className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left text-foreground hover:bg-muted/80 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="font-medium">打开文件夹…</span>
            </div>
            <kbd className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded border border-border/60">
              Ctrl+O
            </kbd>
          </button>

          {/* Reveal in explorer (Electron only) */}
          {currentWorkspace && window.autumnflow?.openPath && (
            <button
              type="button"
              onClick={handleRevealInExplorer}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>在资源管理器中显示</span>
            </button>
          )}

          {/* Recent Workspaces section */}
          {recentWorkspaces.length > 0 && (
            <>
              <div className="my-1 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground font-semibold flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>最近打开的项目</span>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {recentWorkspaces.map((rw) => {
                  const isCurrent = rw.path === currentWorkspace;
                  return (
                    <button
                      key={rw.path}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onSelectWorkspace(rw.path, rw.name);
                      }}
                      title={rw.path}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left transition-colors ${
                        isCurrent
                          ? "bg-accent text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/80"
                      }`}
                    >
                      <div className="flex flex-col min-w-0 pr-2">
                        <span className="truncate text-xs">{rw.name}</span>
                        <span className="truncate text-[10px] text-muted-foreground/70 font-mono">
                          {rw.path}
                        </span>
                      </div>
                      {isCurrent && <Check className="w-3.5 h-3.5 text-foreground shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
